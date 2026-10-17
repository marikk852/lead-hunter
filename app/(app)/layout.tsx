import Link from "next/link";
import { logoutAction } from "@/src/auth/actions";
import { requireOwner } from "@/src/auth/session";
import { getAIProvider } from "@/src/ai";
import { LanguageSwitcher } from "@/src/components/language-switcher";
import { prisma } from "@/src/lib/db";
import { getI18n } from "@/src/i18n";

export default async function ConsoleLayout({ children }: LayoutProps<"/">) {
  await requireOwner();

  const { locale, t } = await getI18n();

  const [profile, dueCount] = await Promise.all([
    prisma.developerProfile.findUnique({ where: { id: "owner" }, select: { name: true } }),
    prisma.followUp.count({ where: { done: false, dueAt: { lte: new Date() } } }),
  ]);

  const provider = getAIProvider();

  const nav = [
    { href: "/dashboard", label: t.nav.overview },
    { href: "/leads", label: t.nav.leads },
    { href: "/leads/new", label: t.nav.addLead },
    { href: "/settings", label: t.nav.settings },
  ];

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-ink-800 bg-ink-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
          <Link href="/dashboard" className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-ink-50">
              {t.nav.brand}
            </span>
            <span className="label hidden sm:inline">{t.nav.console}</span>
          </Link>

          <nav className="flex items-center gap-1">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-2.5 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-850 hover:text-ink-50"
              >
                {item.label}
                {item.href === "/leads" && dueCount > 0 ? (
                  <span className="num ml-1.5 text-hot">{dueCount}</span>
                ) : null}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <span className="label hidden md:inline">
              {provider.name === "heuristic" ? t.nav.providerRules : provider.name}
            </span>
            <span className="hidden text-xs text-ink-400 sm:inline">
              {profile?.name ?? t.settings.name}
            </span>
            <LanguageSwitcher current={locale} label={t.common.language} />
            <form action={logoutAction}>
              <button
                type="submit"
                className="text-xs text-ink-400 transition-colors hover:text-ink-50"
              >
                {t.common.signOut}
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6">{children}</main>

      <footer className="border-t border-ink-800 px-5 py-4">
        <p className="mx-auto max-w-6xl text-xs text-ink-600">{t.footer.disclaimer}</p>
      </footer>
    </div>
  );
}
