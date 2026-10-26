import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { createSqlAdapter } from "./adapter";
import { googleOAuthConfigured } from "./google";

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  return {
    adapter: createSqlAdapter(),
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
    trustHost: true,
    session: { strategy: "database" },
    pages: {
      signIn: "/login",
      error: "/login",
    },
    providers: googleOAuthConfigured() ? [Google({ clientId, clientSecret })] : [],
    callbacks: {
      session({ session, user }) {
        session.user.id = user.id;
        return session;
      },
    },
  };
});
