/** The login/setup/apply cover: an exercise-book page — ruled lines and a red margin rule (the one decorative motif). */
export function BookCover({ school, motto }: { school: string; motto?: string }) {
  return (
    <aside className="on-dark relative hidden overflow-hidden bg-ink-900 text-white lg:flex lg:flex-col lg:justify-end" aria-hidden={false}>
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "repeating-linear-gradient(to bottom, transparent 0, transparent 2.4rem, rgba(125,223,210,0.13) 2.4rem, rgba(125,223,210,0.13) calc(2.4rem + 1px))", backgroundPosition: "0 1.2rem" }} />
      <div className="pointer-events-none absolute inset-y-0 left-16 w-px bg-[#e0584b]/70" />
      <div className="relative z-10 py-16 pr-14 pl-24">
        <p className="font-serif text-5xl leading-[1.1] font-semibold text-balance">{school}</p>
        {motto && <p className="mt-5 max-w-[34ch] text-lg text-ink-200">{motto}</p>}
      </div>
    </aside>
  );
}
