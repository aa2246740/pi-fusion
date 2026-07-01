import type { EvidenceEntry } from "./types.js";

interface CatalogSource {
  trigger: RegExp;
  title: string;
  url: string;
  snippet: string;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const SOURCES: CatalogSource[] = [
  {
    trigger: /progressive disclosure|navigation|discoverability|cognitive load|dashboard|tabs?|accordion/i,
    title: "Nielsen Norman Group — Progressive Disclosure",
    url: "https://www.nngroup.com/articles/progressive-disclosure/",
    snippet: "Canonical UX reference for deferring advanced or less-common options until needed to reduce initial complexity.",
  },
  {
    trigger: /recognition|recall|navigation|learnability|legacy|older|novice/i,
    title: "Nielsen Norman Group — Recognition and Recall in User Interfaces",
    url: "https://www.nngroup.com/articles/recognition-and-recall/",
    snippet: "UX reference for reducing memory load by making actions, options, and navigation cues visible.",
  },
  {
    trigger: /hidden navigation|persistent navigation|navigation|discoverability|hamburger|menu|dashboard/i,
    title: "Nielsen Norman Group — Hidden Navigation and Discoverability",
    url: "https://www.nngroup.com/articles/hamburger-menus/",
    snippet: "NN/g quantitative usability tests of hidden versus visible navigation: hidden main navigation cut discoverability almost in half and made desktop task completion at least 39% slower (roughly a 30–40% slowdown), with content discoverability more than 20% lower, perceived task difficulty 21% higher, and desktop navigation 5–7 seconds longer; critical ERP paths should stay persistently visible.",
  },
  {
    trigger: /change management|adoption|training|proficiency|utilization|time-to-competency|migration|transition|roi/i,
    title: "Prosci — People-side ROI factors for change management",
    url: "https://www.prosci.com/blog/the-case-for-change-management",
    snippet: "Prosci source for making the change-management case in terms of project results: when initiatives change how people do their jobs, the people-side ROI factors are speed of adoption, ultimate utilization, and proficiency, so ERP migrations should measure adoption pace, real use, and task competence after go-live.",
  },
  {
    trigger: /sap|s\/4hana|fiori/i,
    title: "SAP Fiori Design Guidelines",
    url: "https://www.sap.com/design-system/fiori-design-web",
    snippet: "Official SAP Fiori UX guidance covering launchpad/app patterns, object pages, forms, navigation, and guided flows.",
  },
  {
    trigger: /sap|s\/4hana|fiori|object page|business object|anchor|section/i,
    title: "SAP Fiori Elements — Object Page Overview",
    url: "https://www.sap.com/design-system/fiori-design-web/v1-96/discover/frameworks/sap-fiori-elements/object-page/object-page-overview-sap-fiori-elements",
    snippet: "Official SAP Fiori Elements guidance for object pages, including business-object layout, header, sections, and navigation patterns.",
  },
  {
    trigger: /sap|s\/4hana|fiori|wizard|guided|step/i,
    title: "SAP Learning — Working with SAP Fiori Design Guidelines",
    url: "https://learning.sap.com/courses/ui-development-with-sap-fiori/working-with-sap-fiori-design-guidelines_ab11c169-54de-4f51-87b9-f61c8a5198be",
    snippet: "Official SAP learning material pointing implementers to Fiori design guidance for consistent application patterns.",
  },
  {
    trigger: /sap|s\/4hana|fiori|inventory|work order|production/i,
    title: "SAP Fiori Apps Reference Library",
    url: "https://fioriappslibrary.hana.ondemand.com/sap/fix/externalViewer/",
    snippet: "Official SAP app reference for S/4HANA role-based apps and implementation metadata.",
  },
  {
    trigger: /dynamics|microsoft|inventory|production|work order|task guide|fasttab|action pane/i,
    title: "Microsoft Learn — Dynamics 365 Supply Chain Management documentation",
    url: "https://learn.microsoft.com/en-us/dynamics365/supply-chain/",
    snippet: "Official Microsoft documentation for Supply Chain Management workflows such as inventory, production control, workspaces, task guides, forms, and operational pages.",
  },
  {
    trigger: /netsuite|oracle|inventory|manufacturing|work order|global search|center|role/i,
    title: "Oracle NetSuite Help Center — User guides index",
    url: "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/preface_3710621755.html",
    snippet: "Official Oracle NetSuite help index for product areas such as inventory management, manufacturing, customization, roles/centers, and navigation basics.",
  },
  {
    trigger: /netsuite|oracle|global search|search/i,
    title: "Oracle NetSuite Help — Global Search",
    url: "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4307693953.html",
    snippet: "Official NetSuite global-search documentation for finding records from the header search field.",
  },
  {
    trigger: /netsuite|oracle|center|role|dashboard|navigation/i,
    title: "Oracle NetSuite Help — Centers, Roles, and Dashboards",
    url: "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0713121656.html",
    snippet: "Official NetSuite guidance for role-based centers, dashboards, and navigation structure.",
  },
  {
    trigger: /netsuite|oracle|item 360|inventory|dashboard/i,
    title: "Oracle NetSuite Help — Item 360 Dashboard",
    url: "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_2145345562.html",
    snippet: "Official NetSuite Item 360 dashboard documentation for inventory-related visibility and action context.",
  },
  {
    trigger: /netsuite|oracle|work order|manufacturing|production/i,
    title: "NetSuite — Work Order Management",
    url: "https://www.netsuite.com/portal/products/erp/production-management/work-order-management.shtml",
    snippet: "Official NetSuite product documentation for work order management and manufacturing execution workflows.",
  },
  {
    trigger: /wizard|guided|step|multi-step|progressive disclosure/i,
    title: "Nielsen Norman Group — Wizards",
    url: "https://www.nngroup.com/articles/wizards/",
    snippet: "UX research guidance on when wizards help by breaking complex workflows into sequential steps, and when they hurt expert efficiency.",
  },
  {
    trigger: /interaction design|progressive disclosure|cognitive load|usability|older|novice/i,
    title: "Interaction Design Foundation — Progressive Disclosure",
    url: "https://www.interaction-design.org/literature/topics/progressive-disclosure",
    snippet: "UX education/reference source for progressive disclosure and complexity management concepts.",
  },
];

export function seedUxSourceCatalog(prompt: string): EvidenceEntry[] {
  if (!/\b(ux|usability|navigation|erp|sap|netsuite|dynamics|adoption|training|proficiency|cognitive load|progressive disclosure|dashboard|inventory|work order|manufacturing)\b/i.test(prompt)) return [];
  const entries: EvidenceEntry[] = [];
  const seen = new Set<string>();
  for (const source of SOURCES) {
    if (!source.trigger.test(prompt)) continue;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    entries.push({
      id: `ux-catalog-${stableHash(source.url)}`,
      source: "web_search",
      url: source.url,
      title: source.title,
      snippet: source.snippet,
      participantSlotIndex: -1,
      fetchedAt: Date.now(),
    });
  }
  return entries.slice(0, 10);
}
