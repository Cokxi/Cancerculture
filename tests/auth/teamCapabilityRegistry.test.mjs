import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ACTIVE_TEAM_CAPABILITY_KEYS,
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
  getRegisteredTeamCapability,
  isRegisteredTeamCapabilityKey,
} from "../../lib/auth/teamCapabilityRegistry.ts";

const activatedKeys = [
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
];
const expectedKeys = [
  "submissions.submission_phase.moderate",
  ...activatedKeys,
  "submissions.reports.view",
  "submissions.reports.review",
  "submissions.reports.live.view",
  "submissions.reports.finalized.view",
  "submissions.reports.assign",
  "users.flag",
  "users.flag.create",
  "users.flag.view",
  "users.flag.review",
  "users.warnings.issue",
  "users.warnings.overrule",
  "users.warnings.view",
  "users.directory.basic.view",
  "users.directory.full.view",
  "users.disqualified_submissions.view",
  "users.upload_blocks.view",
  "users.website_bans.view",
  "users.website_bans.create",
  "users.website_bans.revoke",
  "logs.website_bans.view",
  "logs.uploads.view",
  "logs.avatar_uploads.view",
  "logs.votes.view",
  "logs.vote_refunds.view",
  "logs.submission_moderation.view",
  "logs.submission_reporters.view",
  "logs.submission_report_moderation.view",
  "logs.team_authorization.view",
  "cycles.logs.view",
  "cycles.manage",
  "votes.refund_disqualified",
  "rules.manage",
  "faq.manage",
  "homepage_content.manage",
  "community.polls.manage",
  "community.comment_reports.view",
  "community.comment_reports.review",
  "community.comments.moderate",
  "community.comment_spam.view",
  "community.comment_spam.review",
  "logs.community_comment_moderation.view",
  "donation_organizations.manage",
  "sponsorships.reports.view",
  "winners.payouts.view",
  "winners.payout_logs.view",
  "winners.manage_payouts",
  "winners.recipient_corrections.manage",
];

function canonicalDefinition(definition) {
  return {
    key: definition.key,
    display_name: definition.displayName,
    description: definition.description,
    category: definition.category,
    included_actions: definition.includedActions,
    excluded_actions: definition.excludedActions,
    risk_level: definition.riskLevel,
    assignable_to_non_admin:
      definition.assignableToNonAdmin,
    implementation_version:
      definition.implementationVersion,
  };
}

test("the server registry contains fifty-two known, forty-eight active, and no staged capability keys", () => {
  assert.deepEqual(
    [...REGISTERED_TEAM_CAPABILITY_KEYS],
    expectedKeys
  );
  assert.equal(new Set(expectedKeys).size, expectedKeys.length);
  assert.deepEqual(
    Object.keys(TEAM_CAPABILITY_REGISTRY),
    expectedKeys
  );
  assert.deepEqual(
    [...ACTIVE_TEAM_CAPABILITY_KEYS],
    expectedKeys.filter(
      (key) =>
        ![
          "submissions.submission_phase.moderate",
          "submissions.reports.view",
          "submissions.reports.assign",
          "users.flag",
        ].includes(key)
    )
  );
  assert.deepEqual(
    expectedKeys.filter(
      (key) => TEAM_CAPABILITY_REGISTRY[key].lifecycle === "staged"
    ),
    []
  );
  assert.equal(expectedKeys.includes("users.flag.create"), true);
  assert.equal(expectedKeys.includes("votes.refund_disqualified"), true);
  assert.equal(expectedKeys.includes("logs.vote_refunds.view"), true);
  assert.equal(
    expectedKeys.includes("users.disqualified_submissions.view"),
    true
  );
});

test("registry metadata is complete and hashes match canonical definitions", () => {
  const expectedHashes = {
    "submissions.submission_phase.moderate":
      "7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b",
    "submissions.submission_phase.disqualify":
      "3eec3024438e68d08891e147a1d770ad812af935732b6e60a804baa6a28b1732",
    "submissions.submission_phase.reinstate":
      "7c0cfbaf53b08c43633f75c025ccf729ae3dbc9d4320c90b11117415ee304dd2",
    "submissions.voting_phase.disqualify":
      "cb6ad152ee22b164b6c864f26dcaab25f10be3483bfa5b1f3a7b265c66a142de",
    "submissions.voting_phase.reinstate":
      "4e4f1d199d4eb008d768676796bcf8ec34c2472c90d323fecbf7b247d7a36fe0",
    "submissions.reports.view":
      "1ac94f21aa019436dfae29e33349f7640fc3ea026586cb6c159c85b85245b1e9",
    "submissions.reports.review":
      "106f2027e9ba597867aa4bafa80871f8432c3c27a3cae980061e09930b5b36e1",
    "submissions.reports.live.view":
      "a32d78f7a26954a5465cd1f1ba05e871d0cf62e69721a7fa4cd83353562fa4fa",
    "submissions.reports.finalized.view":
      "878dc43e7c22ec06a968fd6c7fa069f936688ef5da82db1caf80b7bf9c462a4f",
    "submissions.reports.assign":
      "7e8c8683353d35f1bc817a2967c64ff934cc1a905db8ab9beaf1a693713b3ea6",
    "users.flag":
      "4ec252dadafc8d9e149df225825f850fd90666e444fff4edaca43bd5d02b553c",
    "users.flag.create":
      "284ad15bb26a61110b34d96f51b199ed0223d66bbe81462e7e89fd534972231b",
    "users.flag.view":
      "54e6644753e36c355d69b4ca9aa80ef93d9b4b3040d4103a58e56b2a10f55add",
    "users.flag.review":
      "8ec44455bd08212cab4cacc64dfcd96b139edd9753862255d68150e702b26869",
    "users.warnings.issue":
      "8910867c7eb547473efaf129089bf2e0098d6f471e2057358ddd77f90818811f",
    "users.warnings.overrule":
      "ce5849bc151746eddf520ed960002a6f0c7e4a9c7b0c9eac58721d4c40603ece",
    "users.warnings.view":
      "c3a987a6878787bcd56e6e1e9ebbe791419c510c47c768a18bf2354bc81a85d8",
    "users.directory.basic.view":
      "5d0d0ab97601631a43f7ba87ba04d0007bf6534449774ac859f838e370cede48",
    "users.directory.full.view":
      "df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1",
    "users.disqualified_submissions.view":
      "0519db20cffc9d57d6feb8e54dca7633711cbebec26754ad986aac10685ce839",
    "users.upload_blocks.view":
      "174c20de72228105c16c01b98a9da10f232ecdbe2f9e6c1f0b309a1c37479204",
    "users.website_bans.view":
      "4e8d362ef56b5f101e66ac6d3db552f505ecf6c4580dbefe36f397d4571e7388",
    "users.website_bans.create":
      "66118e044f0defc403ce7a63539a30156b4000bd0a05dbeeafe73a9661407470",
    "users.website_bans.revoke":
      "1a5b5dd1c07c638051dc76ea079561baff6b8204b17be017d04e186de6b09706",
    "logs.website_bans.view":
      "a3ce56bd99c5e3aa74ff1d863a8969b73cd23717cc9ced50a7c8c375cda743e3",
    "logs.uploads.view":
      "3968acde89ace9d541824c1e010573c0d5b3be4b30f6b75b8e5a3dd543ad2a2b",
    "logs.avatar_uploads.view":
      "d9b917101f9051d91eef9f2f20cbfa738fcd8787abe8283b0862d007416d5813",
    "logs.votes.view":
      "991f2ef3ae5b454d3b1fec1c8fbc15ed64f845049553c6ba1cd07fe3bc0c09da",
    "logs.vote_refunds.view":
      "f3e1102733e29e8338b95f831e89f9f09f7f7af70ce4dfcfce51cba450c358b2",
    "logs.submission_moderation.view":
      "fc820ff4bea36171834588856c8f1ca09f0b0391d0b04ff6c0521fffa85d88e7",
    "logs.submission_reporters.view":
      "854f3ddd41413b3223ed220d4f6a86d4f6f14436ce05de6d225dd255e6dc7846",
    "logs.submission_report_moderation.view":
      "848b90d2b81ec364bd0c122cdd2e31ad68380d0e82d2f921c90467229e8108d7",
    "logs.team_authorization.view":
      "69faf8e792eb9ee98366d3be382d6020ba46994b514c07c3ab2e970c716be1ba",
    "cycles.logs.view":
      "915c24cf6a167040c8637e59ca27a28510c6299b2ea417ae770f86e992924beb",
    "cycles.manage":
      "c0ba905e5e737ca1d09afa197f1bcb9adaf8919e7fb6fb37d33b53cfb54fb38a",
    "votes.refund_disqualified":
      "bd49530c7905d71661f47b343ca8de9251d47c6c7712e84494563075ba8e68ab",
    "rules.manage":
      "d7097dece0897ddcd924010a9a8cd48f427512231eaf7da77a28005536720887",
    "faq.manage":
      "7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93",
    "homepage_content.manage":
      "b9f5db882c8fa65f235ef2fe83f1cc90515761e21ea885e4ca80e58b2476957a",
    "community.polls.manage":
      "042a289cd77aca920ab6d07abec54cec1b380423c90aa3693b7fbb11537a9a7e",
    "community.comment_reports.view":
      "31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775",
    "community.comment_reports.review":
      "b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9",
    "community.comments.moderate":
      "68c743df9ccd4dba9cf6f511a0d7b737e1d7ba84450425722846912784c17e9f",
    "community.comment_spam.view":
      "389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da",
    "community.comment_spam.review":
      "eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76",
    "logs.community_comment_moderation.view":
      "6db2fa540e00d5146aebbfe021eec0a26dea7bf1078f59a5dda74ad8a5813ea3",
    "donation_organizations.manage":
      "18240d25d2183ebb17f7b1a56345ab2acc3906455d253b90cfee79cd5d6aa58d",
    "sponsorships.reports.view":
      "421c31be87cac7864a7fb6fad229e614befed4d38374f0fc05e285ffaa24d655",
    "winners.payouts.view":
      "9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54",
    "winners.payout_logs.view":
      "91f8ef9be3147c220c0591843f752145c2b2f865424f58afc76ab0b21448e019",
    "winners.manage_payouts":
      "37bc1cd814466cbdca9276fe722bd610ced8b7baf1106b905f8a62a51a8c7a26",
    "winners.recipient_corrections.manage":
      "e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd",
  };

  for (const key of expectedKeys) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const hash = createHash("sha256")
      .update(
        JSON.stringify(canonicalDefinition(definition)),
        "utf8"
      )
      .digest("hex");

    assert.equal(definition.key, key);
    assert.ok(definition.displayName.length > 0);
    assert.ok(definition.description.length > 0);
    assert.ok(definition.category.length > 0);
    assert.ok(definition.includedActions.length > 0);
    assert.ok(definition.excludedActions.length > 0);
    const deprecated = [
      "submissions.submission_phase.moderate",
      "submissions.reports.view",
      "submissions.reports.assign",
      "users.flag",
    ].includes(key);
    const versionTwo =
      deprecated ||
      activatedKeys.includes(key) ||
      key.startsWith("users.flag.") ||
      key === "users.directory.full.view" ||
      key === "logs.vote_refunds.view" ||
      key === "cycles.manage" ||
      key === "winners.payouts.view" ||
      key === "winners.manage_payouts" ||
      key === "winners.recipient_corrections.manage" ||
      key === "community.comment_reports.view";
    const versionFour = key === "submissions.reports.review";
    const versionThree = key === "users.flag.view";
    assert.equal(definition.assignableToNonAdmin, !deprecated);
    assert.equal(
      definition.lifecycle,
      deprecated ? "deprecated" : "active"
    );
    assert.equal(
      definition.implementationVersion,
      versionFour ? 4 : versionThree ? 3 : versionTwo ? 2 : 1
    );
    assert.equal(definition.definitionHash, expectedHashes[key]);
    assert.equal(hash, expectedHashes[key]);
  }
});

test("unknown keys fail closed and cannot be synthesized", () => {
  for (const value of [
    "users.unknown",
    "users.*",
    "canFlagUsers",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isRegisteredTeamCapabilityKey(value), false);
    assert.equal(getRegisteredTeamCapability(value), null);
  }
});

test("the registry and every nested definition are runtime immutable", () => {
  assert.equal(Object.isFrozen(TEAM_CAPABILITY_REGISTRY), true);
  assert.equal(
    Object.isFrozen(REGISTERED_TEAM_CAPABILITY_KEYS),
    true
  );

  for (const definition of Object.values(
    TEAM_CAPABILITY_REGISTRY
  )) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.includedActions), true);
    assert.equal(Object.isFrozen(definition.excludedActions), true);
  }

  assert.throws(() => {
    TEAM_CAPABILITY_REGISTRY["users.flag"].displayName =
      "Changed";
  }, TypeError);
  assert.throws(() => {
    TEAM_CAPABILITY_REGISTRY["users.flag"].includedActions.push(
      "Changed"
    );
  }, TypeError);
});
