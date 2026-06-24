import type { ModelCaller, ObligationPlan } from "./types.js";

function parseJsonResponse<T>(answer: string): T {
  const trimmed = answer.trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`Obligation planner returned invalid JSON: ${answer.slice(0, 200)}`);
}

function normalizePlan(plan: ObligationPlan): ObligationPlan {
  const obligations = Array.isArray(plan.obligations) ? plan.obligations : [];
  return {
    obligations: obligations
      .filter((obligation) => obligation && typeof obligation.description === "string" && obligation.description.trim())
      .slice(0, 24)
      .map((obligation, index) => ({
        id: obligation.id?.trim() || `obligation-${index + 1}`,
        kind: obligation.kind ?? "other",
        description: obligation.description.trim(),
        ...(obligation.entities?.length ? { entities: obligation.entities.slice(0, 8) } : {}),
        ...(obligation.timePeriod ? { timePeriod: obligation.timePeriod } : {}),
        ...(obligation.expectedEvidence?.length ? { expectedEvidence: obligation.expectedEvidence.slice(0, 8) } : {}),
        ...(obligation.preferredSourceTypes?.length ? { preferredSourceTypes: obligation.preferredSourceTypes.slice(0, 8) } : {}),
        status: obligation.status ?? "unknown",
      })),
    ...(Array.isArray(plan.notes) ? { notes: plan.notes.slice(0, 12) } : {}),
  };
}

export function formatObligationPlanForModel(plan: ObligationPlan | undefined): string {
  if (!plan?.obligations.length) return "";
  const lines = [
    "",
    "## Internal Fusion Requirement Checklist",
    "This checklist was generated only from the user's prompt. It is not an answer key or benchmark rubric. Use it to avoid missing requested entities, metrics, source categories, calculations, and caveats. Do not mention this checklist in the final answer.",
    "",
  ];

  for (const obligation of plan.obligations) {
    const details = [
      obligation.entities?.length ? `entities=${obligation.entities.join(", ")}` : undefined,
      obligation.timePeriod ? `period=${obligation.timePeriod}` : undefined,
      obligation.preferredSourceTypes?.length ? `preferred sources=${obligation.preferredSourceTypes.join(", ")}` : undefined,
      obligation.expectedEvidence?.length ? `evidence needed=${obligation.expectedEvidence.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    lines.push(`- [${obligation.id}] (${obligation.kind}) ${obligation.description}${details ? ` — ${details}` : ""}`);
  }

  if (plan.notes?.length) {
    lines.push("", "Notes:");
    for (const note of plan.notes) lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

export class ObligationPlanner {
  private caller: ModelCaller;
  private model: string;

  constructor(caller: ModelCaller, model: string) {
    this.caller = caller;
    this.model = model;
  }

  async plan(prompt: string): Promise<ObligationPlan> {
    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: PLAN] You are planning a multi-model answer.
Create an obligation checklist ONLY from the user's prompt. Do not use web tools. Do not infer hidden benchmark rubrics, answer keys, or expected values. The checklist should capture what the final answer must cover to satisfy the user: requested metrics, comparisons, entities, time periods, source categories, calculations, caveats, and decision/recommendation outputs.
For public-health or service-delivery comparison prompts, make the checklist source-retrieval friendly: separate requested indicators from delivery-model inputs, preserve each setting/entity and time span from the prompt, and put any prompt-named source systems, reports, datasets, or publications into preferredSourceTypes or expectedEvidence. Do not invent source names, years, entities, or values.

Return ONLY valid JSON:
{
  "obligations": [
    {
      "id": "short-kebab-case-id",
      "kind": "metric" | "comparison" | "source" | "calculation" | "recommendation" | "caveat" | "other",
      "description": "what must be answered",
      "entities": ["optional entity names"],
      "timePeriod": "optional period/year range",
      "expectedEvidence": ["what evidence/value/calculation is needed"],
      "preferredSourceTypes": ["official filings", "vendor docs", "peer-reviewed studies", "public health surveillance", "etc"],
      "status": "unknown"
    }
  ],
  "notes": ["brief planning notes, if useful"]
}

Keep the checklist concise but complete. Prefer 8-18 obligations for complex prompts, fewer for simple prompts.`,
      messages: [{ role: "user", content: prompt }],
    });

    return normalizePlan(parseJsonResponse<ObligationPlan>(result.answer));
  }
}
