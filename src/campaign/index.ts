export { CHRISTMAS_PILOT_EMAIL_TEMPLATES } from "./christmas-pilot-templates.js";
export { renderTemplate, shouldUsePrefilledCopy } from "./template-render.js";
export { getTemplateForStep, listCampaignTemplates } from "./templates.js";
export { orchestrateChristmasPilot } from "./orchestrate.js";
export { listBusinessDaysInclusive, addBusinessDaysYmd, pickEtBusinessSendTime } from "./business-days.js";
export { buildKpList, isKpEligible } from "./kp-rank.js";
export {
  cancelOpenEmailTodosForClient,
  advanceKpOnHardBounce,
  lockActiveKeyPersonAfterSend,
} from "./lifecycle.js";
export { isCampaignHistoryPage, resolveCampaignOutboundSend } from "./resolve-send.js";
export { resolveCampaignCopy } from "./render-for-send.js";
export type {
  CampaignChannel,
  CampaignTemplateRow,
  ProductLine,
  TemplateRenderVars,
} from "./types.js";
