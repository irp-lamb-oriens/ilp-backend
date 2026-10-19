import { loadSync } from "dotenv/mod.ts";
loadSync({ export: true, allowEmptyValues: true });
import get from "../db/get.ts";

const id = Deno.args[0] ?? "maria_garcia_example_com";
const d = await get("clients", id);
console.log(JSON.stringify({
  id,
  isPlaceholder: d?.isPlaceholder,
  stage: d?.stage,
  name: d?.name,
  email: d?.email,
  hasStatusComments: Array.isArray(d?.statusComments),
  statusCommentsCount: d?.statusComments?.length,
  hasStageRatings: d?.stageRatings != null,
  hasCharges: Array.isArray(d?.charges),
  hasQuotes: Array.isArray(d?.quotes),
  hasStatusChatThread: Array.isArray(d?.statusChatThread),
  statusChatThreadCount: d?.statusChatThread?.length,
}, null, 2));