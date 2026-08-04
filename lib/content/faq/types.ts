export type FaqContentSection = Readonly<{
  id: string;
  title: string;
  paragraphs: readonly string[];
  bullets: readonly string[];
}>;

export type FaqContentDocument = Readonly<{
  schemaVersion: 1;
  eyebrow: string;
  heading: string;
  introduction: string;
  sections: readonly FaqContentSection[];
}>;

export type FaqRevisionSummary = Readonly<{
  id: number;
  revisionNumber: number;
  content: FaqContentDocument;
  createdAt: string;
  createdBy: string | null;
}>;

export type AdminFaqContentState = Readonly<{
  stateVersion: number;
  published: FaqRevisionSummary;
  updatedAt: string;
  updatedBy: string | null;
}>;
