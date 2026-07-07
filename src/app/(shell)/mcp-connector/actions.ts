"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTenant, ADMIN_ROLES } from "@/lib/tenant";
import { mintToken, revokeToken } from "@/lib/mcp/tokens";

async function requireAdmin() {
  const tenant = await requireTenant();
  if (!ADMIN_ROLES.includes(tenant.role)) {
    redirect("/mcp-connector?err=forbidden");
  }
  return tenant;
}

/** Generate a new MCP token. The raw token is passed back via the URL once so
 *  the page can show it (it's not stored in readable form anywhere else). */
export async function mintTokenAction(formData: FormData): Promise<void> {
  const tenant = await requireAdmin();
  const label = String(formData.get("label") ?? "").trim() || "MCP connector";
  const token = await mintToken(tenant.id, label);
  revalidatePath("/mcp-connector");
  redirect(`/mcp-connector?minted=${encodeURIComponent(token)}`);
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const tenant = await requireAdmin();
  const token = String(formData.get("token") ?? "").trim();
  if (token) await revokeToken(tenant.id, token);
  revalidatePath("/mcp-connector");
  redirect("/mcp-connector?revoked=1");
}
