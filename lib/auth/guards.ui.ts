

export type TeamMemberUI = {
  role: "admin" | "mod";
};

export function requireAdminUI(member: TeamMemberUI) {
  if (member.role !== "admin") {
    throw new Error("Admin only");
  }
}

export function requireModOrAdminUI(member: TeamMemberUI) {
  if (member.role !== "admin" && member.role !== "mod") {
    throw new Error("Forbidden");
  }
}
