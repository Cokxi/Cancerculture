export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getValidatedApplicationOrigin,
  sanitizeInternalReturnPath,
} from "@/lib/auth/oauth/safeReturnPath";
import { validateOAuthState } from "@/lib/auth/oauth/state";
import { supabaseAdmin } from "@/lib/db/admin";
import { touchUserLog } from "@/lib/logging/touchUserLog";

type OAuthFailureStage =
  | "oauth_configuration"
  | "oauth_state_validation"
  | "oauth_callback_parameters"
  | "discord_token_exchange"
  | "discord_user_fetch"
  | "user_context_sync"
  | "access_check"
  | "session_insert"
  | "unexpected";

class OAuthCallbackError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 500 | 503,
    readonly stage: OAuthFailureStage,
    readonly publicMessage: string,
    readonly causeValue?: unknown,
    readonly code = "AUTHENTICATION_FAILED"
  ) {
    super(publicMessage);
    this.name = "OAuthCallbackError";
  }
}

type DiscordTokenPayload = {
  accessToken: string;
  tokenType: "Bearer";
};

type DiscordUserPayload = {
  id: string;
  username: string;
  avatar: string | null;
};

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function expireCookie(response: NextResponse, name: string) {
  response.cookies.set(name, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function clearOAuthCookies(response: NextResponse) {
  expireCookie(response, "oauth_state");
  expireCookie(response, "oauth_redirect_path");
}

function createFailureResponse(
  error: OAuthCallbackError,
  applicationOrigin: URL | null
) {
  const response =
    error.status === 403 && applicationOrigin
      ? NextResponse.redirect(
          new URL(
            `/banned?code=${encodeURIComponent(error.code)}`,
            applicationOrigin
          ),
          307
        )
      : NextResponse.json(
          { error: error.code },
          { status: error.status }
        );

  response.headers.set("X-Auth-Error-Code", error.code);
  response.headers.set("Cache-Control", "no-store");
  clearOAuthCookies(response);
  expireCookie(response, "session_id");
  expireCookie(response, "discord_user_id");

  return response;
}

function parseDiscordTokenPayload(
  payload: unknown
): DiscordTokenPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const token = payload as Record<string, unknown>;
  const accessToken =
    typeof token.access_token === "string"
      ? token.access_token.trim()
      : "";
  const tokenType =
    typeof token.token_type === "string"
      ? token.token_type.trim()
      : "";

  if (!accessToken || tokenType.toLowerCase() !== "bearer") {
    return null;
  }

  return { accessToken, tokenType: "Bearer" };
}

function parseDiscordUserPayload(
  payload: unknown
): DiscordUserPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const user = payload as Record<string, unknown>;
  const id = typeof user.id === "string" ? user.id.trim() : "";
  const username =
    typeof user.username === "string"
      ? user.username.trim()
      : "";
  const avatar =
    typeof user.avatar === "string" ? user.avatar : null;

  if (!/^\d{5,32}$/.test(id) || !username) {
    return null;
  }

  return { id, username, avatar };
}

function getProviderFailureStatus(status: number): 401 | 503 {
  return status === 429 || status >= 500 ? 503 : 401;
}

async function parseJsonResponse(
  response: Response,
  stage: "discord_token_exchange" | "discord_user_fetch"
) {
  try {
    return await response.json();
  } catch (error) {
    throw new OAuthCallbackError(
      503,
      stage,
      "Discord authentication is temporarily unavailable",
      error
    );
  }
}

async function deletePartialSession(sessionId: string) {
  const { error } = await supabaseAdmin
    .from("sessions")
    .delete()
    .eq("id", sessionId);

  if (error) {
    console.error("[AUTH_OAUTH] session_cleanup", error);
  }
}

export async function GET(req: Request) {
  let sessionCleanupId: string | null = null;
  let applicationOrigin: URL | null = null;

  try {
    const clientId = process.env.DISCORD_CLIENT_ID?.trim();
    const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
    const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();

    if (!clientId || !clientSecret || !redirectUri) {
      throw new OAuthCallbackError(
        500,
        "oauth_configuration",
        "Authentication is temporarily unavailable"
      );
    }

    try {
      applicationOrigin = getValidatedApplicationOrigin(
        process.env.NEXT_PUBLIC_BASE_URL
      );
    } catch (error) {
      throw new OAuthCallbackError(
        500,
        "oauth_configuration",
        "Authentication is temporarily unavailable",
        error
      );
    }

    if (!applicationOrigin) {
      throw new OAuthCallbackError(
        500,
        "oauth_configuration",
        "Authentication is temporarily unavailable"
      );
    }

    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const returnedState = searchParams.get("state");
    const cookieStore = await cookies();
    const storedState = cookieStore.get("oauth_state")?.value;
    const redirectPath = sanitizeInternalReturnPath(
      cookieStore.get("oauth_redirect_path")?.value,
      applicationOrigin
    );

    if (!validateOAuthState(returnedState, storedState)) {
      throw new OAuthCallbackError(
        400,
        "oauth_state_validation",
        "Invalid or expired OAuth state"
      );
    }

    if (!code) {
      throw new OAuthCallbackError(
        400,
        "oauth_callback_parameters",
        "Invalid OAuth callback"
      );
    }

    let tokenResponse: Response;

    try {
      tokenResponse = await fetch(
        "https://discord.com/api/oauth2/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
          }),
          cache: "no-store",
        }
      );
    } catch (error) {
      throw new OAuthCallbackError(
        503,
        "discord_token_exchange",
        "Discord authentication is temporarily unavailable",
        error
      );
    }

    if (!tokenResponse.ok) {
      const status = getProviderFailureStatus(tokenResponse.status);
      throw new OAuthCallbackError(
        status,
        "discord_token_exchange",
        status === 401
          ? "Discord authorization failed"
          : "Discord authentication is temporarily unavailable"
      );
    }

    const token = parseDiscordTokenPayload(
      await parseJsonResponse(
        tokenResponse,
        "discord_token_exchange"
      )
    );

    if (!token) {
      throw new OAuthCallbackError(
        401,
        "discord_token_exchange",
        "Discord authorization failed"
      );
    }

    let userResponse: Response;

    try {
      userResponse = await fetch(
        "https://discord.com/api/users/@me",
        {
          headers: {
            Authorization: `${token.tokenType} ${token.accessToken}`,
          },
          cache: "no-store",
        }
      );
    } catch (error) {
      throw new OAuthCallbackError(
        503,
        "discord_user_fetch",
        "Discord authentication is temporarily unavailable",
        error
      );
    }

    if (!userResponse.ok) {
      const status = getProviderFailureStatus(userResponse.status);
      throw new OAuthCallbackError(
        status,
        "discord_user_fetch",
        status === 401
          ? "Discord identity validation failed"
          : "Discord authentication is temporarily unavailable"
      );
    }

    const user = parseDiscordUserPayload(
      await parseJsonResponse(userResponse, "discord_user_fetch")
    );

    if (!user) {
      throw new OAuthCallbackError(
        401,
        "discord_user_fetch",
        "Discord identity validation failed"
      );
    }

    try {
      await touchUserLog({
        discordUserId: user.id,
        discordUsername: user.username,
        discordAvatar: user.avatar,
        throwOnError: true,
      });
    } catch (error) {
      throw new OAuthCallbackError(
        503,
        "user_context_sync",
        "Authentication data is temporarily unavailable",
        error
      );
    }

    const sessionId = randomUUID();
    const successResponse = NextResponse.redirect(
      new URL(redirectPath, applicationOrigin)
    );

    sessionCleanupId = sessionId;

    const { data: sessionResult, error: sessionError } =
      await supabaseAdmin.rpc("create_cancerculture_session", {
        p_session_id: sessionId,
        p_discord_user_id: user.id,
      });

    if (sessionError) {
      throw new OAuthCallbackError(
        503,
        "session_insert",
        "Authentication data is temporarily unavailable",
        sessionError,
        "AUTHENTICATION_UNAVAILABLE"
      );
    }

    const normalizedSessionResult =
      sessionResult && typeof sessionResult === "object"
        ? (sessionResult as Record<string, unknown>)
        : {};
    const sessionOutcome =
      typeof normalizedSessionResult.outcome === "string"
        ? normalizedSessionResult.outcome
        : "";

    if (sessionOutcome !== "created") {
      const deniedCode =
        sessionOutcome === "discord_banned"
          ? "DISCORD_BANNED"
          : sessionOutcome === "website_banned"
            ? "WEBSITE_BANNED"
            : sessionOutcome === "not_in_discord"
              ? "NOT_IN_DISCORD"
              : sessionOutcome === "joined_too_recently"
                ? "JOINED_TOO_RECENTLY"
                : "AUTHENTICATION_UNAVAILABLE";
      const deniedStatus =
        deniedCode === "AUTHENTICATION_UNAVAILABLE" ? 503 : 403;

      throw new OAuthCallbackError(
        deniedStatus,
        "access_check",
        deniedStatus === 403
          ? "This account cannot sign in"
          : "Authentication data is temporarily unavailable",
        undefined,
        deniedCode
      );
    }

    successResponse.cookies.set("session_id", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    expireCookie(successResponse, "discord_user_id");
    clearOAuthCookies(successResponse);
    sessionCleanupId = null;

    return successResponse;
  } catch (error) {
    if (sessionCleanupId) {
      await deletePartialSession(sessionCleanupId);
    }

    const oauthError =
      error instanceof OAuthCallbackError
        ? error
        : new OAuthCallbackError(
            500,
            "unexpected",
            "Authentication failed",
            error
          );

    console.error(
      `[AUTH_OAUTH] ${oauthError.stage}`,
      oauthError.causeValue ?? { status: oauthError.status }
    );

    return createFailureResponse(oauthError, applicationOrigin);
  }
}
