export type HomepageInfoBlock = {
  id: number;
  title: string | null;
  body: string;
  displayOrder: number;
  linkLabel: string | null;
  linkUrl: string | null;
};

export type AdminHomepageInfoBlock = HomepageInfoBlock & {
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};
