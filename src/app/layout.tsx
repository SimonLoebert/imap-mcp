import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "IMAP MCP",
  description: "Self-hosted remote MCP server for multi-account IMAP/SMTP",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
