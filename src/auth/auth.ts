import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  ConflictException,
  UnauthorizedException,
  Inject,
  forwardRef,
  Injectable,
} from "@nestjs/common";
import { IsEmail, IsString, Length, MinLength } from "class-validator";
import { hash, verify } from "argon2";
import { createHash, randomBytes, randomUUID } from "crypto";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../shared/prisma";
import { JwtGuard, Public, audience, issuer, secret } from "../shared/http";
class Credentials {
  @IsEmail() email!: string;
  @IsString() @Length(8, 128) password!: string;
}
class Login {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}
class Refresh {
  @IsString() @MinLength(20) refreshToken!: string;
}
class Logout {
  @IsString() @MinLength(1) refreshToken!: string;
}
class Forgot {
  @IsEmail() email!: string;
}
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(forwardRef(() => AuthService)) private readonly s: any,
  ) {}
  @Public() @Post("register") register(@Body() b: Credentials) {
    return this.s.register(b);
  }
  @Public() @Post("login") login(@Body() b: Login) {
    return this.s.login(b);
  }
  @Public() @Post("refresh") refresh(@Body() b: Refresh) {
    return this.s.refresh(b.refreshToken);
  }
  @Public() @Post("logout") @HttpCode(204) logout(@Body() b: Logout) {
    return this.s.logout(b.refreshToken);
  }
  @Public() @Post("forgot-password") @HttpCode(202) forgot(@Body() b: Forgot) {
    return this.s.forgot(b.email);
  }
  @Post("onboarding/complete") @UseGuards(JwtGuard) @HttpCode(204) complete(
    @Req() r: any,
  ) {
    return this.s.complete(r.user.sub);
  }
}
@Injectable()
export class AuthService {
  constructor(
    private db: PrismaService,
    private jwt: JwtService,
  ) {}
  norm(e: string) {
    return e.trim().toLowerCase();
  }
  async register(b: Credentials) {
    const email = this.norm(b.email);
    if (await this.db.user.findUnique({ where: { email } }))
      throw new ConflictException("An account with this email already exists.");
    const u = await this.db.user.create({
      data: { email, passwordHash: await hash(b.password) },
    });
    return this.issue(u);
  }
  async login(b: Login) {
    const u = await this.db.user.findUnique({
      where: { email: this.norm(b.email) },
    });
    if (!u || !(await verify(u.passwordHash, b.password)))
      throw new UnauthorizedException("Email or password is incorrect.");
    return this.issue(u);
  }
  async issue(u: any, familyId = randomUUID()) {
    const raw = randomBytes(48).toString("base64url"),
      tokenHash = digest(raw),
      id = randomUUID();
    await this.db.authSession.create({
      data: {
        id,
        userId: u.id,
        tokenHash,
        familyId,
        expiresAt: new Date(
          Date.now() + Number(process.env.REFRESH_TOKEN_DAYS || 30) * 86400000,
        ),
      },
    });
    const accessToken = await this.jwt.signAsync(
      { sub: u.id, email: u.email, sid: id },
      {
        secret: secret(),
        issuer: issuer(),
        audience: audience(),
        expiresIn: process.env.ACCESS_TOKEN_TTL || "15m",
      } as any,
    );
    return {
      accessToken,
      refreshToken: raw,
      user: { id: u.id, email: u.email },
      onboardingComplete: u.onboardingComplete,
    };
  }
  async refresh(raw: string) {
    const tokenHash = digest(raw);
    const s = await this.db.authSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!s || s.revokedAt || s.expiresAt < new Date()) {
      if (s?.replacedByHash)
        await this.db.authSession.updateMany({
          where: { familyId: s.familyId },
          data: { revokedAt: new Date() },
        });
      throw new UnauthorizedException("Your session has expired.");
    }
    const next = randomBytes(48).toString("base64url");
    const nh = digest(next);
    const id = randomUUID();
    await this.db.$transaction([
      this.db.authSession.update({
        where: { id: s.id },
        data: { revokedAt: new Date(), replacedByHash: nh },
      }),
      this.db.authSession.create({
        data: {
          id,
          userId: s.userId,
          tokenHash: nh,
          familyId: s.familyId,
          expiresAt: new Date(
            Date.now() +
              Number(process.env.REFRESH_TOKEN_DAYS || 30) * 86400000,
          ),
        },
      }),
    ]);
    const accessToken = await this.jwt.signAsync(
      { sub: s.user.id, email: s.user.email, sid: id },
      {
        secret: secret(),
        issuer: issuer(),
        audience: audience(),
        expiresIn: process.env.ACCESS_TOKEN_TTL || "15m",
      } as any,
    );
    return {
      accessToken,
      refreshToken: next,
      user: { id: s.user.id, email: s.user.email },
      onboardingComplete: s.user.onboardingComplete,
    };
  }
  async logout(raw: string) {
    await this.db.authSession.updateMany({
      where: { tokenHash: digest(raw) },
      data: { revokedAt: new Date() },
    });
  }
  async forgot(email: string) {
    const u = await this.db.user.findUnique({
      where: { email: this.norm(email) },
    });
    if (u) {
      const raw = randomBytes(32).toString("base64url");
      await this.db.passwordReset.create({
        data: {
          userId: u.id,
          tokenHash: digest(raw),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
    }
  }
  async complete(id: string) {
    await this.db.user.update({
      where: { id },
      data: { onboardingComplete: true },
    });
  }
}
