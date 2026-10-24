import {
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { AuthGuard, PassportModule, PassportStrategy } from "@nestjs/passport";
import { passportJwtSecret } from "jwks-rsa";
import { ExtractJwt, Strategy } from "passport-jwt";

export type AuthConfig = { issuer: string; audience: string; jwksUri: string };

export function authConfigFromEnv(env = process.env): AuthConfig {
  const { AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URI } = env;
  if (!AUTH_ISSUER || !AUTH_AUDIENCE || !AUTH_JWKS_URI)
    throw new Error(
      "AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URI are required",
    );
  return {
    issuer: AUTH_ISSUER,
    audience: AUTH_AUDIENCE,
    jwksUri: AUTH_JWKS_URI,
  };
}

const isPublic = Symbol("isPublic");
export const Public = () => SetMetadata(isPublic, true);

class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: AuthConfig) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Validação local com chaves em cache: o IdP fica fora do caminho de cada request.
      secretOrKeyProvider: passportJwtSecret({
        jwksUri: config.jwksUri,
        cache: true,
        rateLimit: true,
      }),
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
    });
  }

  validate(payload: { providerId?: unknown }) {
    if (typeof payload.providerId !== "string" || payload.providerId === "")
      return false;
    return { providerId: payload.providerId };
  }
}

type AuthenticatedRequest = {
  user: { providerId: string };
  params?: Record<string, unknown>;
  body?: unknown;
};

@Injectable()
class ProviderGuard extends AuthGuard("jwt") implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(isPublic, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    await (super.canActivate(context) as Promise<boolean>);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const body = request.body;
    const claimed = [
      request.params?.providerId,
      typeof body === "object" && body !== null && "providerId" in body
        ? body.providerId
        : undefined,
    ];
    // Camada extra: o domínio continua validando provider, player e wallet.
    if (
      claimed.some(
        (providerId) =>
          providerId !== undefined && providerId !== request.user.providerId,
      )
    )
      throw new ForbiddenException({ code: "PROVIDER_IDENTITY_MISMATCH" });
    return true;
  }

  override handleRequest<User>(error: unknown, user: User | false): User {
    if (error || !user)
      throw new UnauthorizedException({ code: "UNAUTHORIZED" });
    return user;
  }
}

@Module({})
export class AuthModule {
  static register(config?: AuthConfig): DynamicModule {
    if (config === undefined) return { module: AuthModule };
    return {
      module: AuthModule,
      imports: [PassportModule],
      providers: [
        { provide: JwtStrategy, useFactory: () => new JwtStrategy(config) },
        { provide: APP_GUARD, useClass: ProviderGuard },
      ],
    };
  }
}
