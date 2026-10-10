"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FinanceSummary } from "@/lib/contracts";
import { formatMonth } from "@/lib/dates";
import { CURRENCY, LOCALE, formatMoney } from "@/lib/money";

const compact = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  notation: "compact",
  maximumFractionDigits: 1,
});

const SERIES = [
  { key: "income", label: "Collected", color: "var(--chart-1)" },
  { key: "expense", label: "Paid out", color: "var(--chart-2)" },
] as const;

/**
 * Money in and out per month, settled amounts only. Two series on one axis,
 * with a legend, a hover tooltip and the same figures available as a table.
 */
export function CashflowChart({ months }: { months: FinanceSummary["byMonth"] }) {
  const data = months.map((m) => ({
    label: formatMonth(m.month),
    income: m.incomeCents / 100,
    expense: m.expenseCents / 100,
    net: m.netCents,
  }));

  return (
    <figure>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="h-60" role="img" aria-label="Bar chart of money collected and paid out each month. The table below has the same figures.">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2} barCategoryGap="28%" margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: "var(--chart-grid)" }}
              tick={{ fontSize: 12, fill: "var(--chart-axis)" }}
            />
            <YAxis
              width={52}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12, fill: "var(--chart-axis)" }}
              tickFormatter={(value: number) => compact.format(value)}
            />
            <Tooltip
              cursor={{ fill: "var(--sunken)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as (typeof data)[number];
                return (
                  <div className="rounded-control border border-line bg-surface px-3 py-2 text-[0.8125rem] shadow-raised">
                    <p className="mb-1 font-semibold text-ink">{label}</p>
                    {SERIES.map((s) => (
                      <p key={s.key} className="flex items-center justify-between gap-6 text-body">
                        <span className="flex items-center gap-1.5">
                          <span className="size-2 rounded-sm" style={{ background: s.color }} aria-hidden />
                          {s.label}
                        </span>
                        <span className="num font-medium text-ink">{formatMoney(Math.round(row[s.key] * 100))}</span>
                      </p>
                    ))}
                    <p className="mt-1 flex justify-between gap-6 border-t border-line pt-1 text-body">
                      <span>Net</span>
                      <span className="num font-medium text-ink">{formatMoney(row.net, { signed: true })}</span>
                    </p>
                  </div>
                );
              }}
            />
            {SERIES.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-3 text-[0.8125rem]">
        <summary className="w-fit rounded font-medium text-brand hover:underline">Show as table</summary>
        <table className="mt-2 w-full max-w-md text-left">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="py-1 font-semibold">Month</th>
              <th scope="col" className="py-1 text-right font-semibold">Collected</th>
              <th scope="col" className="py-1 text-right font-semibold">Paid out</th>
              <th scope="col" className="py-1 text-right font-semibold">Net</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className="border-t border-line">
                <th scope="row" className="py-1.5 font-medium text-ink">{formatMonth(m.month)}</th>
                <td className="num py-1.5 text-right">{formatMoney(m.incomeCents)}</td>
                <td className="num py-1.5 text-right">{formatMoney(m.expenseCents)}</td>
                <td className="num py-1.5 text-right">{formatMoney(m.netCents, { signed: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
