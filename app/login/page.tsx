import { redirect } from "next/navigation";
import { loginAction } from "@/src/auth/actions";
import { isAuthenticated } from "@/src/auth/session";
import { LanguageSwitcher } from "@/src/components/language-switcher";
import { getI18n } from "@/src/i18n";
import { env } from "@/src/lib/env";
import { readParam } from "@/src/lib/params";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await isAuthenticated()) redirect("/dashboard");

  const { locale, t } = await getI18n();
  const params = await searchParams;
  const errorKey = readParam(params, "error");
  const error = errorKey
    ? (t.login.errors[errorKey as keyof typeof t.login.errors] ?? t.login.errors.generic)
    : null;

  const { OWNER_PASSWORD, OWNER_PASSWORD_HASH } = env();
  const configured = Boolean(OWNER_PASSWORD?.trim() || OWNER_PASSWORD_HASH?.trim());

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <header className="mb-8">
          <div className="flex items-start justify-between gap-4">
            <p className="label">{t.login.kicker}</p>
            {/* Reachable before sign-in on purpose: the choice is a cookie-only
                display preference, and nobody should have to read a foreign
                language to find the password field. */}
            <LanguageSwitcher current={locale} label={t.common.language} />
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-50">
            {t.login.heading}
          </h1>
          <p className="mt-2 text-sm text-ink-400">{t.login.subtitle}</p>
        </header>

        <form action={loginAction} className="panel p-5">
          <label htmlFor="password" className="label block">
            {t.login.passwordLabel}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            className="mt-2 w-full border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 placeholder:text-ink-600 focus:border-ink-400"
            placeholder={t.login.passwordPlaceholder}
          />

          {error ? (
            <p role="alert" className="mt-3 border-l-2 border-hot pl-3 text-sm text-hot">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="mt-5 w-full border border-hot bg-hot px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-ink-50 hover:border-ink-50"
          >
            {t.login.submit}
          </button>

          {!configured ? (
            <p className="mt-4 text-xs leading-relaxed text-ink-400">
              {t.login.setupHintBefore} <span className="num">{t.login.setupHintPassword}</span>{" "}
              {t.login.setupHintMiddle} <span className="num">{t.login.setupHintEnv}</span>{" "}
              {t.login.setupHintAfter}{" "}
              <span className="num">npm run set-password</span> {t.login.setupHintThen}{" "}
              <span className="num">OWNER_PASSWORD_HASH</span>.
            </p>
          ) : null}
        </form>

        <p className="mt-6 text-xs text-ink-600">{t.login.cookieNote}</p>
      </div>
    </main>
  );
}
