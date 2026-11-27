/**
 * A page in place of its data when the database does not answer. Rendering the page with empty
 * data instead would show an account with nothing in it, and that reads as lost data (#765).
 */
export function DatabaseDownPage({ title }: { title: string }) {
  return (
    <main className="oui-page max-w-5xl">
      <header className="mb-6">
        <h1 className="oui-title">{title}</h1>
      </header>
      <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
        The database is not answering, so this page cannot show your data right now. Nothing is
        shown rather than an empty account. Try again in a few minutes.
      </div>
    </main>
  );
}
