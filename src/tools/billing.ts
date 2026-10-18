import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAccessToken, getProjectId } from "../firebase.js";
import { formatError, truncateResult } from "../utils.js";

const BILLING_BASE = "https://cloudbilling.googleapis.com/v1";
const BUDGETS_BASE = "https://billingbudgets.googleapis.com/v1";

interface BillingInfo {
  name?: string;
  projectId?: string;
  billingAccountName?: string;
  billingEnabled?: boolean;
}

interface BillingAccount {
  name?: string;
  open?: boolean;
  displayName?: string;
  currencyCode?: string;
}

interface Budget {
  name?: string;
  displayName?: string;
  amount?: {
    specifiedAmount?: { currencyCode?: string; units?: string; nanos?: number };
    lastPeriodAmount?: Record<string, never>;
  };
  thresholdRules?: Array<{ thresholdPercent?: number; spendBasis?: string }>;
}

async function billingFetch(url: string, accessToken: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** Formats a Google Money-style amount ({units, nanos}) into a number. */
function moneyToNumber(amount?: { units?: string; nanos?: number }): number | undefined {
  if (!amount) return undefined;
  const units = amount.units ? Number(amount.units) : 0;
  const nanos = amount.nanos ? amount.nanos / 1e9 : 0;
  return units + nanos;
}

export function registerBillingTools(server: McpServer): void {
  server.registerTool(
    "firebase_billing_status",
    {
      description:
        "Show the billing status and budget configuration for a Firebase/GCP " +
        "project: which billing account it is linked to, whether billing is " +
        "enabled, the account's currency, and any configured budgets with their " +
        "alert thresholds. Works with no setup via the Cloud Billing API. " +
        "Note: Google does not expose actual spend/cost amounts through this API " +
        "— a real cost breakdown in currency requires a BigQuery billing export, " +
        "which this tool does not depend on.",
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe("Project ID to inspect. Defaults to the active project."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ projectId }) => {
      try {
        const targetProject = projectId ?? getProjectId();
        if (!targetProject) {
          throw new Error("No project ID available (none active and none provided).");
        }

        const accessToken = await getAccessToken();

        // 1. Project billing info (billing account + enabled flag).
        const infoRes = await billingFetch(
          `${BILLING_BASE}/projects/${encodeURIComponent(targetProject)}/billingInfo`,
          accessToken
        );
        if (!infoRes.ok) {
          const body = await infoRes.text();
          throw new Error(
            `Cloud Billing API returned ${infoRes.status} ${infoRes.statusText} ` +
            `for project ${targetProject}.\n${body}`
          );
        }
        const info = (await infoRes.json()) as BillingInfo;

        const result: Record<string, unknown> = {
          projectId: targetProject,
          billingEnabled: info.billingEnabled ?? false,
          billingAccountName: info.billingAccountName ?? null,
          note:
            "Actual spend/cost amounts are not available via the Cloud Billing " +
            "API. For a real cost breakdown, enable a BigQuery billing export " +
            "or view the Billing → Reports page in the Google Cloud Console.",
        };

        // 2. Billing account details (display name, currency, open status).
        let account: BillingAccount | null = null;
        if (info.billingAccountName) {
          const acctRes = await billingFetch(
            `${BILLING_BASE}/${info.billingAccountName}`,
            accessToken
          );
          if (acctRes.ok) {
            account = (await acctRes.json()) as BillingAccount;
            result.billingAccount = {
              id: info.billingAccountName.replace("billingAccounts/", ""),
              displayName: account.displayName ?? null,
              open: account.open ?? null,
              currencyCode: account.currencyCode ?? null,
            };
          } else {
            result.billingAccount = {
              id: info.billingAccountName.replace("billingAccounts/", ""),
              detailsError: `Could not read account details (${acctRes.status}).`,
            };
          }
        }

        // 3. Budgets (best-effort: the Budgets API often needs extra setup;
        //    we never fail the tool if it is unavailable).
        if (info.billingAccountName) {
          try {
            const budRes = await billingFetch(
              `${BUDGETS_BASE}/${info.billingAccountName}/budgets`,
              accessToken
            );
            if (budRes.ok) {
              const data = (await budRes.json()) as { budgets?: Budget[] };
              result.budgets = (data.budgets ?? []).map((b) => ({
                displayName: b.displayName ?? null,
                amount: moneyToNumber(b.amount?.specifiedAmount) ?? null,
                currency: b.amount?.specifiedAmount?.currencyCode ?? account?.currencyCode ?? null,
                isLastPeriodAmount: Boolean(b.amount?.lastPeriodAmount),
                thresholds: (b.thresholdRules ?? []).map((t) => ({
                  percent: t.thresholdPercent ?? 0,
                  spendBasis: t.spendBasis ?? "CURRENT_SPEND",
                })),
              }));
            } else {
              result.budgets = {
                unavailable:
                  `Budgets could not be read (${budRes.status}). This usually ` +
                  `means the Cloud Billing Budget API is not enabled or the ` +
                  `credentials lack a quota project — no setup is required for ` +
                  `the billing status above.`,
              };
            }
          } catch {
            result.budgets = { unavailable: "Budgets API not reachable." };
          }
        }

        return {
          content: [{ type: "text", text: truncateResult(result) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );
}
