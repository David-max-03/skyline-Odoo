"use client";

import { Database, Info, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { FactKindBadge } from "@/components/domain";
import { Badge, Button, Card, ErrorState, Notice, PageHeader, Skeleton } from "@/components/ui";
import { api, errorMessage, useApi } from "@/lib/api-client";
import type { AssistantAnswer } from "@/lib/contracts";

interface Status {
  engine: "rules" | "claude";
  label: string;
  suggestions: string[];
}

interface Exchange {
  id: number;
  question: string;
  answer: AssistantAnswer | null;
  error: string | null;
}

export default function AssistantPage() {
  const status = useApi<Status>("/api/assistant");
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState<Exchange[]>([]);
  const [asking, setAsking] = useState(false);
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (thread.length > 0) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || asking) return;
    const id = nextId.current++;
    setThread((t) => [...t, { id, question: q, answer: null, error: null }]);
    setQuestion("");
    setAsking(true);
    try {
      const answer = await api<AssistantAnswer>("/api/assistant", { method: "POST", body: { question: q } });
      setThread((t) => t.map((x) => (x.id === id ? { ...x, answer } : x)));
    } catch (error) {
      setThread((t) => t.map((x) => (x.id === id ? { ...x, error: errorMessage(error) } : x)));
    } finally {
      setAsking(false);
    }
  }

  const suggestions = thread.at(-1)?.answer?.suggestions ?? status.data?.suggestions ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Assistant"
        description="Ask about events, money, members and tasks. Every figure is calculated by Skyline from your records, and each one is marked as an actual, an estimate or a suggestion."
      />

      {status.error && !status.data ? (
        <Card>
          <ErrorState message={status.error.message} onRetry={status.reload} />
        </Card>
      ) : !status.data ? (
        <Skeleton className="h-12" />
      ) : (
        <Notice tone={status.data.engine === "claude" ? "brand" : "neutral"} icon={status.data.engine === "claude" ? Sparkles : Info}>
          {status.data.label}
        </Notice>
      )}

      <ol className="mt-6 space-y-6" aria-live="polite">
        {thread.map((x) => (
          <li key={x.id} className="animate-rise space-y-3">
            <p className="ml-auto w-fit max-w-[85%] rounded-card rounded-br-sm bg-brand px-4 py-2.5 text-sm text-on-brand">{x.question}</p>
            {x.error ? (
              <Notice tone="bad">{x.error}</Notice>
            ) : !x.answer ? (
              <div role="status" className="space-y-2">
                <span className="sr-only">Working out the answer…</span>
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-8/12" />
              </div>
            ) : (
              <Card className="overflow-hidden">
                <div className="px-5 py-4">
                  <p className="whitespace-pre-line text-[0.9375rem] leading-relaxed text-ink">{x.answer.answer}</p>
                  {x.answer.notice && (
                    <Notice tone="warn" icon={Info} className="mt-3">
                      {x.answer.notice}
                    </Notice>
                  )}
                </div>
                {x.answer.facts.length > 0 && (
                  <dl className="border-t border-line">
                    {x.answer.facts.map((fact, i) => (
                      <div
                        key={i}
                        className="grid gap-x-4 gap-y-1 border-b border-line px-5 py-2.5 text-sm last:border-0 sm:grid-cols-[6.5rem_1fr_auto] sm:items-baseline"
                      >
                        <div>
                          <FactKindBadge kind={fact.kind} />
                        </div>
                        <dt className="text-muted">{fact.label}</dt>
                        <dd className={fact.kind === "recommendation" ? "text-body sm:col-span-2 sm:col-start-2" : "num font-medium text-ink sm:text-right"}>
                          {fact.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-sunken/60 px-5 py-2.5 text-xs text-muted">
                  <Badge tone={x.answer.engine === "claude" ? "brand" : "neutral"}>{x.answer.engineLabel}</Badge>
                  {x.answer.sources.length > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Database className="size-3" aria-hidden />
                      From: {x.answer.sources.join(", ")}
                    </span>
                  )}
                </footer>
              </Card>
            )}
          </li>
        ))}
      </ol>
      <div ref={endRef} />

      <div className="sticky bottom-0 -mx-4 mt-6 border-t border-line bg-canvas/95 px-4 pb-4 pt-3 backdrop-blur sm:-mx-6 sm:px-6">
        {suggestions.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-2" aria-label="Suggested questions">
            {suggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  disabled={asking}
                  onClick={() => void ask(s)}
                  className="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[0.8125rem] font-medium text-body transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand-deep disabled:opacity-60"
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            placeholder="How many tickets must the Winter Gala sell to break even?"
            aria-label="Your question"
            className="h-12 min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-4 text-[0.9375rem] text-ink placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
          <Button type="submit" size="lg" icon={Send} loading={asking} disabled={!question.trim()}>
            Ask
          </Button>
        </form>
      </div>
    </div>
  );
}
