import Link from "next/link";

export function SiteHeader({ cta = true }: { cta?: boolean }) {
  return (
    <header className="border-b border-rule bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-6 px-5 py-3.5">
        <Link href="/" className="text-[1.2rem] font-semibold tracking-[-0.04em] text-pine">
          Traceline
        </Link>
        <nav className="flex items-center gap-5 text-[15px]">
          <a href="/#file" className="hidden sm:inline">
            The file
          </a>
          <a href="/#method" className="hidden sm:inline">
            Method
          </a>
          <a href="/#who" className="hidden md:inline">
            Who it is for
          </a>
          {cta ? (
            <Link href="/analyze" className="on-ink px-3 py-1.5">
              Analyze a statement
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
