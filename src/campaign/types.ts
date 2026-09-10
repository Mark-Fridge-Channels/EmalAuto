export type ProductLine = "DTC" | "ASIN_Plus";

export type CampaignChannel = "Email" | "LinkedIn";

export interface CampaignTemplateRow {
  pageId: string;
  url?: string;
  name: string;
  campaignKey: string;
  productLine: ProductLine;
  stepIndex: number;
  channel: CampaignChannel;
  subjectTemplate: string;
  bodyTemplate: string;
  minGapBusinessDays: number;
  windowStart: string | null;
  windowEnd: string | null;
  dailyCapPerMailbox: number | null;
  active: boolean;
}

export interface TemplateRenderVars {
  "First Name": string;
  "Brand Name": string;
  "DTC Christmas Pilot Page": string;
  "ASIN Plus Christmas Pilot Page": string;
  "Sender Name": string;
  [key: string]: string;
}
