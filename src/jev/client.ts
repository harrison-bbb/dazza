import { z } from 'zod';

/**
 * Jev, TypeSafe's classifier: it reads a state (the text to judge) and answers
 * typed questions about it with calibrated probabilities. It never writes
 * text. Dazza asks it for decisions (which model a task needs, whether a
 * handoff's evidence holds up) and falls back to doing what it would have done
 * anyway when Jev can't answer, so every failure here is a value, not a throw.
 *
 * Every question in one request sees the same state, and extra questions cost
 * only their own tokens, so callers ask everything they need at once.
 */

export const JEV_API_BASE = 'https://api.typesafe.ai';
export const JEV_MODEL = 'jev-latest';

/** Yes or no: `noul` is the probability of yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

/** One of a set of options, each with what it means. Up to 255. */
export interface ChoiceQuestion<O extends string = string> {
  type: 'choice';
  instructions: string;
  criteria: Record<O, string>;
}

/** A position on an ordered scale of 2 to 10 levels, lowest first. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer<O extends string = string> {
  type: 'choice';
  choice: O;
  probabilities: Record<O, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted, from 0 to the number of levels less one. */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

/** The answer each question gets, typed by the question: a choice comes back as one of its options. */
export type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : NoulAnswer;

export type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: AnswerFor<Q[K]> };

/** Why Jev couldn't answer. None of them should stop Dazza doing its work. */
export type JevError =
  | { kind: 'auth'; message: string }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'unreachable'; message: string }
  | { kind: 'bad_response'; message: string };

export type JevResult<Q extends Record<string, Question>> =
  | { ok: true; model: string; answers: Answers<Q>; usage?: { inputTokens: number } }
  | { ok: false; error: JevError };

export interface JevOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  model?: string;
  /** For the whole call, retry included. Jev usually answers in about 100 ms. */
  timeoutMs?: number;
  /** Before the one retry on a busy service. Tests set 0. */
  retryDelayMs?: number;
}

/**
 * Jev takes up to about 64,000 tokens of state. Dazza's states are task text
 * and handoff evidence, far below that; anything near it is a mistake, refused
 * here rather than paid for.
 */
const STATE_LIMIT = 100_000;

const Probabilities = z.record(z.string(), z.number());
const AnswerShape = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: Probabilities,
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: Probabilities,
    confidence: z.number().min(0).max(1),
  }),
]);
const Reply = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number() }).partial().optional(),
});

export class JevClient {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(private readonly options: JevOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = `${(options.baseUrl ?? JEV_API_BASE).replace(/\/+$/, '')}/v1/systemone`;
  }

  /** Ask every question about one state, in one call. */
  async ask<Q extends Record<string, Question>>(
    state: string | Record<string, unknown> | string[],
    questions: Q,
    signal?: AbortSignal,
  ): Promise<JevResult<Q>> {
    const body = JSON.stringify({
      model: this.options.model ?? JEV_MODEL,
      state,
      questions,
    });
    if (body.length > STATE_LIMIT) {
      return fail('invalid', 'That’s too much to send Jev in one question.');
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 3_000);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body,
          signal: stop,
        });
      } catch {
        return timeout.aborted
          ? fail('timeout', 'Jev didn’t answer in time.')
          : fail('unreachable', 'Couldn’t reach Jev.');
      }
      // Busy: one retry, as TypeSafe asks, if there's time left for it.
      if (!busy(response.status) || attempt === 2) break;
      if (!(await pause(this.options.retryDelayMs ?? 300, stop))) {
        return fail('timeout', 'Jev didn’t answer in time.');
      }
    }
    if (!response) return fail('unreachable', 'Couldn’t reach Jev.');
    if (!response.ok) return fail(errorKind(response.status), await describe(response));

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return fail('bad_response', 'Jev’s reply wasn’t JSON.');
    }
    return read(raw, questions);
  }
}

/** Check the reply answers every question, each in the shape it was asked. */
export function read<Q extends Record<string, Question>>(raw: unknown, questions: Q): JevResult<Q> {
  const reply = Reply.safeParse(raw);
  if (!reply.success) return fail('bad_response', 'Jev’s reply wasn’t in the expected shape.');
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = AnswerShape.safeParse(reply.data.answers[id]);
    if (!answer.success || answer.data.type !== question.type) {
      return fail('bad_response', `Jev didn’t answer “${id}”.`);
    }
    if (
      question.type === 'choice' &&
      answer.data.type === 'choice' &&
      !Object.hasOwn(question.criteria, answer.data.choice)
    ) {
      return fail('bad_response', `Jev answered “${id}” with an option it wasn’t given.`);
    }
    answers[id] = answer.data;
  }
  const inputTokens = reply.data.usage?.input_tokens;
  return {
    ok: true,
    model: reply.data.model,
    answers: answers as Answers<Q>,
    ...(inputTokens !== undefined && { usage: { inputTokens } }),
  };
}

function fail(kind: JevError['kind'], message: string): { ok: false; error: JevError } {
  return { ok: false, error: { kind, message } };
}

const busy = (status: number) => status === 429 || status === 529 || status === 503;

function errorKind(status: number): JevError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (busy(status)) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid';
  return 'unreachable';
}

/**
 * What went wrong, from the status and TypeSafe's own message when it gives
 * one. Never the request: it carries the key.
 */
async function describe(response: Response): Promise<string> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>;
      const nested = typeof b.error === 'object' && b.error !== null ? b.error : undefined;
      const found = [
        b.message,
        b.detail,
        b.error,
        (nested as Record<string, unknown>)?.message,
      ].find((v) => typeof v === 'string');
      if (typeof found === 'string') detail = found.slice(0, 200);
    }
  } catch {
    // No body worth reading: the status says enough.
  }
  const base =
    response.status === 401 || response.status === 403
      ? 'Jev didn’t accept the TypeSafe key'
      : `Jev answered ${response.status}`;
  return detail ? `${base}: ${detail}` : `${base}.`;
}

/** Wait, unless stopped first. Resolves whether the wait finished. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stopped);
      resolve(true);
    }, ms);
    const stopped = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', stopped, { once: true });
  });
}
