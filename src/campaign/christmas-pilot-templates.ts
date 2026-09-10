import type { ProductLine } from "./types.js";

export interface SeedTemplateSpec {
  name: string;
  productLine: ProductLine;
  stepIndex: number;
  subjectTemplate: string;
  bodyTemplate: string;
}

/** Official Christmas Pilot email copy (Email only; LinkedIn excluded this run). */
export const CHRISTMAS_PILOT_EMAIL_TEMPLATES: SeedTemplateSpec[] = [
  {
    name: "DTC Email 1 — Repeated Customer Touchpoint",
    productLine: "DTC",
    stepIndex: 1,
    subjectTemplate: "Turn your Christmas gift into a repeated customer touchpoint",
    bodyTemplate: `Hi {{First Name}},

I'm reaching out because {{Brand Name}} may have the kind of product where a Christmas gift can do more than create a one-time purchase.

In daily-use categories like coffee, a gift can be seen repeatedly — sometimes 10+ times — during the holiday period. It sits on the counter, gets opened in the morning, gets used again, and keeps reminding the recipient of the brand.

Most brands do not capture that moment.

FC helps DTC brands turn that repeated visibility into a Smart Product Touchpoint. The recipient can tap the product, enter a branded Christmas experience, answer a smart survey, unlock a reward, and continue into Shopify / Klaviyo flows.

We are opening a limited paid Christmas Pilot for DTC brands preparing Christmas gifts, bundles, or seasonal product campaigns.

The page explains the setup and timing here:
{{DTC Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "DTC Email 2 — Repeat Purchase",
    productLine: "DTC",
    stepIndex: 2,
    subjectTemplate: "Make Christmas gift drive the next purchase",
    bodyTemplate: `Hi {{First Name}},

One thing we like about Christmas gifting is also the problem most brands miss:

The person who receives the product is often not the person who bought it.

If the recipient likes the product, the brand still needs a way to identify them, learn what they care about, and guide them toward the next purchase.

That is what the FC DTC Christmas Pilot is designed for.

The recipient taps the product, enters a gamified Christmas experience, answers a short smart survey, and receives a personalized next step. That next step can connect into Shopify and Klaviyo, so the gift recipient does not disappear after the holiday moment.

The goal is simple: turn a Christmas recipient into a future customer.

Details are here:
{{DTC Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "DTC Email 3 — Christmas-only No Commission",
    productLine: "DTC",
    stepIndex: 3,
    subjectTemplate: "A Christmas repeat-purchase channel without commission",
    bodyTemplate: `Hi {{First Name}},

Most repeat-purchase channels come with a cost: ads, affiliate fees, marketplace fees, discounting, or some kind of commission.

Christmas creates a different opening.

If the product is already in the customer's hands, the product itself can become the next engagement channel. The brand does not need to rent attention again from a platform.

For this Christmas Pilot only, FC does not take commission from the resulting repeat-purchase or activation path.

It is still a paid pilot. But the upside from the customer interaction — survey response, Shopify action, Klaviyo capture, repeat purchase, or other activation path — stays with the brand.

If that is relevant for your Christmas products, the pilot page is here:
{{DTC Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "DTC Email 4 — October 1 Cutoff",
    productLine: "DTC",
    stepIndex: 4,
    subjectTemplate: "October 1 cutoff for the DTC Christmas Pilot",
    bodyTemplate: `Hi {{First Name}},

Quick reminder on the DTC Christmas Pilot.

October 1 is the practical cutoff for confirming scope if a brand wants to make this work for Christmas.

The reason is not artificial urgency. The product touchpoint, smart survey, gamified experience, Shopify / Klaviyo flow, and dashboard all need to be scoped before the Christmas product moves too far into packaging and fulfillment.

This is most relevant if {{Brand Name}} is preparing a Christmas gift box, bundle, limited edition, or seasonal DTC campaign.

The page is here if you want to check fit before the cutoff:
{{DTC Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "ASIN Plus Email 1 — Repeated Customer Touchpoint",
    productLine: "ASIN_Plus",
    stepIndex: 1,
    subjectTemplate: "Turn your Amazon Christmas product into a repeated customer touchpoint",
    bodyTemplate: `Hi {{First Name}},

I'm reaching out because {{Brand Name}} may have the kind of Amazon product where Christmas creates a useful post-purchase moment.

A Christmas product does not disappear after delivery. In daily-use categories like coffee, it may be seen repeatedly — sometimes 10+ times — during the holiday period.

But for many Amazon brands, the relationship stops inside Amazon.

FC ASIN Plus helps selected products become Smart Product Touchpoints after purchase. The customer can tap the product and enter a brand-owned action path for education, re-engagement, review, reorder, or a brand-site visit.

We are opening a limited paid Christmas Pilot for Amazon brands preparing Christmas products or giftable seasonal items.

The page explains the setup and timing here:
{{ASIN Plus Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "ASIN Plus Email 2 — Repeat Purchase",
    productLine: "ASIN_Plus",
    stepIndex: 2,
    subjectTemplate: "Can your Christmas Gift drive the next order on your Amazon Store?",
    bodyTemplate: `Hi {{First Name}},

Christmas can create a lot of product trial on Amazon.

But trial does not automatically become the next order.

After the product is delivered, most brands have very little control over what happens next. The customer may like the product, but there may be no clear path to reorder, leave a review, learn more, or discover the brand outside the Amazon listing.

FC ASIN Plus is built for that gap.

It adds a Smart Product Touchpoint to selected products, so the post-purchase moment can lead to a specific next action: reorder, review, education, cross-sell, or a brand-site visit.

If Christmas ASINs are part of your plan this year, the pilot page is here:
{{ASIN Plus Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "ASIN Plus Email 3 — Customer Asset",
    productLine: "ASIN_Plus",
    stepIndex: 3,
    subjectTemplate: "Turn Christmas buyers into a brand-owned customer asset",
    bodyTemplate: `Hi {{First Name}},

Amazon can create strong Christmas sales.

The harder question is whether those sales become a customer asset for the brand.

This is especially important during gifting. The buyer, the recipient, and the future repeat customer may be different people. If there is no post-purchase activation layer, the brand may never know who engaged with the product after it was delivered.

FC ASIN Plus helps create that layer.

With a Smart Product Touchpoint on selected products, customers can interact with the brand after purchase. The brand can capture signals such as interest, intent, product preference, and next-step behavior.

The goal is not just a Christmas sales spike.

The goal is to turn Christmas demand into a brand-owned customer asset.

The pilot page is here:
{{ASIN Plus Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "ASIN Plus Email 4 — Christmas-only No Commission",
    productLine: "ASIN_Plus",
    stepIndex: 4,
    subjectTemplate: "A post-purchase channel without added commission",
    bodyTemplate: `Hi {{First Name}},

For many Amazon brands, growth usually comes with extra cost: marketplace fees, ad spend, discounts, affiliate fees, or external traffic costs.

Christmas creates a different kind of opening.

Once the product is in the customer's hands, the product itself can become the next engagement channel. That channel does not need to sit inside another paid platform.

For this Christmas Pilot only, FC does not take commission from the resulting repeat-purchase or activation path.

It is still a paid pilot. But the value created after the customer interacts with the product — reorder, review, brand-site visit, education, or preference capture — stays with the brand.

If this is relevant to your Christmas ASINs, the pilot page is here:
{{ASIN Plus Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
  {
    name: "ASIN Plus Email 5 — October 1 Cutoff",
    productLine: "ASIN_Plus",
    stepIndex: 5,
    subjectTemplate: "October 1 cutoff for the ASIN Plus Christmas Pilot",
    bodyTemplate: `Hi {{First Name}},

Quick reminder on the ASIN Plus Christmas Pilot.

October 1 is the practical cutoff for confirming scope if a brand wants to make this work for Christmas.

The reason is simple: selected products, touchpoint placement, post-purchase action path, and dashboard need to be scoped before holiday packaging and fulfillment move too far ahead.

This is most relevant if {{Brand Name}} is preparing giftable Christmas products, seasonal bundles, or repeat-purchase ASINs.

The page is here if you want to check fit before the cutoff:
{{ASIN Plus Christmas Pilot Page}}

Best,
{{Sender Name}}`,
  },
];
