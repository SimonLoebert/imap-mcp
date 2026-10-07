import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher([
  "/accounts(.*)",
  "/calendars(.*)",
  "/outbox(.*)",
  "/contacts(.*)",
  "/status(.*)",
  "/connect(.*)",
  "/api/accounts(.*)",
  "/api/calendar-accounts(.*)",
  "/api/outbox(.*)",
  "/api/contacts(.*)",
  "/api/message-status(.*)",
  "/api/oauth/authorize(.*)",
]);

const isPublicApi = createRouteMatcher([
  "/api/mcp(.*)",
  "/api/oauth/token(.*)",
  "/api/oauth/register(.*)",
  "/api/oauth/revoke(.*)",
  "/api/attachments/(.*)",
  "/.well-known/(.*)",
]);

export default clerkMiddleware(
  async (auth, req) => {
    if (isPublicApi(req)) return NextResponse.next();
    if (isProtectedRoute(req)) {
      await auth.protect();
    }
    return NextResponse.next();
  },
  { publishableKey: process.env.CLERK_PUBLISHABLE_KEY },
);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
