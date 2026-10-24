const latencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

// Labels só aceitam valores de domínio fixo; identificadores ficam nos logs.
const counters = {
  wager_duplicates_total: {
    help: "Chaves de idempotência ou messageId repetidos, por desfecho.",
    labels: ['outcome="replay"', 'outcome="conflict"'],
  },
  wager_lock_conflicts_total: {
    help: "Submissões abortadas por lock_timeout, deadlock ou serialização.",
    labels: [""],
  },
  wager_message_retries_total: {
    help: "Mensagens SQS devolvidas à fila para nova tentativa.",
    labels: [""],
  },
  wager_dlq_messages_total: {
    help: "Mensagens SQS encaminhadas à DLQ por este processo, por motivo.",
    labels: ['reason="PERMANENT"', 'reason="RETRIES_EXHAUSTED"'],
  },
  outbox_published_total: {
    help: "Eventos da outbox publicados no SQS.",
    labels: [""],
  },
  outbox_publication_retries_total: {
    help: "Falhas de publicação da outbox reagendadas com backoff.",
    labels: [""],
  },
  wallet_reconciliation_divergences_total: {
    help: "Reconciliações com saldo materializado diferente do ledger.",
    labels: [""],
  },
  wager_failed_transactions_total: {
    help: "Transações marcadas FAILED por falha permanente, por código.",
    labels: ['failureCode="PERMANENT_INFRASTRUCTURE_FAILURE"'],
  },
} as const;

type Counters = typeof counters;
export type CounterName = keyof Counters;

export type DatabaseGauges = {
  transactionsByStatus: { status: string; count: string }[];
  outboxPending: string;
  outboxOldestAgeSeconds: string;
};

export class Metrics {
  private readonly values = new Map<string, number>();
  private readonly latency = {
    buckets: latencyBuckets.map((le) => ({ le, count: 0 })),
    sum: 0,
    count: 0,
  };

  increment<N extends CounterName>(
    name: N,
    label: Counters[N]["labels"][number] = "",
  ): void {
    const key = `${name}{${label}}`;
    this.values.set(key, (this.values.get(key) ?? 0) + 1);
  }

  observeProcessing(seconds: number): void {
    for (const bucket of this.latency.buckets)
      if (seconds <= bucket.le) bucket.count++;
    this.latency.sum += seconds;
    this.latency.count++;
  }

  render(gauges: DatabaseGauges): string {
    const lines: string[] = [];
    for (const [name, { help, labels }] of Object.entries(counters)) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const label of labels)
        lines.push(
          `${name}${label && `{${label}}`} ${this.values.get(`${name}{${label}}`) ?? 0}`,
        );
    }
    const h = "wager_processing_duration_seconds";
    lines.push(
      `# HELP ${h} Duração do caso de uso de submissão, HTTP e SQS, inclusive falhas.`,
      `# TYPE ${h} histogram`,
      ...this.latency.buckets.map(
        ({ le, count }) => `${h}_bucket{le="${le}"} ${count}`,
      ),
      `${h}_bucket{le="+Inf"} ${this.latency.count}`,
      `${h}_sum ${this.latency.sum}`,
      `${h}_count ${this.latency.count}`,
      "# HELP wager_transactions Transações persistidas por status, lidas do PostgreSQL.",
      "# TYPE wager_transactions gauge",
      ...gauges.transactionsByStatus.map(
        (row) => `wager_transactions{status="${row.status}"} ${row.count}`,
      ),
      "# HELP outbox_pending_messages Eventos da outbox ainda não publicados.",
      "# TYPE outbox_pending_messages gauge",
      `outbox_pending_messages ${gauges.outboxPending}`,
      "# HELP outbox_lag_seconds Idade do evento pendente mais antigo; 0 sem pendências.",
      "# TYPE outbox_lag_seconds gauge",
      `outbox_lag_seconds ${gauges.outboxOldestAgeSeconds}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
