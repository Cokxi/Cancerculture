export type RulesContentSection = Readonly<{
  id: string;
  title: string;
  paragraphs: readonly string[];
  bullets: readonly string[];
}>;

export type RulesContentDocument = Readonly<{
  schemaVersion: 1;
  eyebrow: string;
  heading: string;
  introduction: string;
  noticeTitle: string;
  noticeBody: string;
  sections: readonly RulesContentSection[];
}>;

export type RulesRevisionSummary = Readonly<{
  id: number;
  revisionNumber: number;
  content: RulesContentDocument;
  createdAt: string;
  createdBy: string | null;
}>;

export type PublishedRulesContent = Readonly<{
  revision: RulesRevisionSummary;
  rulesVersion: number;
  rulesUpdatedAt: string;
}>;

export type AdminRulesContentState = Readonly<{
  stateVersion: number;
  rulesVersion: number;
  published: RulesRevisionSummary;
  draft: RulesRevisionSummary | null;
  updatedAt: string;
  updatedBy: string | null;
}>;
