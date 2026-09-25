import type { ReactNode } from 'react';

/** 404 / 403 / 500 / maintenance (§9.15): calm, centred, one way forward. */
export function SystemPage({
  code,
  title,
  body,
  action,
}: {
  code?: string;
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        {code ? <p className="font-mono text-title-2 text-fg-secondary tabular">{code}</p> : null}
        <h1 className="text-title-1 text-fg">{title}</h1>
        <p className="text-body text-fg-secondary">{body}</p>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </main>
  );
}
