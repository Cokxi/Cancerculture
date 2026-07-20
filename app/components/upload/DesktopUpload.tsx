"use client";

import HomeBlinkCell from "@/app/components/HomeBlinkCell";
import DiscordSyncDelayNotice from "@/app/components/DiscordSyncDelayNotice";
import { SocialPlatformBadge } from "@/app/components/profile/SocialUi";
import ScannerDisplay from "@/app/components/upload/ScannerDisplay";
import DiscordCooldownTimer from "@/app/components/DiscordCooldownTimer";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useOverlay } from "@/app/components/overlay/OverlayProvider";
import CharitiesOverlay from "@/app/components/overlay/CharitiesOverlay";
import RulesOverlay from "@/app/components/overlay/RulesOverlay";
import type { UserSocialSettings } from "@/lib/socials/getUserSocialSettings";
import type { ParticipationAccessState } from "@/lib/eligibility/participation";
import { DISCORD_INVITE_URL } from "@/lib/discordInvite";
import {
  MEDIA_VALIDATION_MESSAGES,
  preflightBrowserImage,
  SUBMISSION_MEDIA_PROFILE,
} from "@/lib/media/profiles";


type PayoutChoice = "keep" | "donate" | "split";
type SubmitState = "idle" | "partial" | "ready";

const CHARITY_OPTIONS = [
  { value: "Animal Haven", label: "Animal Haven" },
  { value: "Animal Rescue Corps, Inc.", label: "Animal Rescue Corps, Inc." },
  { value: "Doctors Without Borders U.S.A., Inc.", label: "Doctors Without Borders U.S.A., Inc." },
  { value: "Feeding Pets of the Homeless", label: "Feeding Pets of the Homeless" },
  { value: "Institute for Justice", label: "Institute for Justice" },
  { value: "No Kid Hungry", label: "No Kid Hungry" },
  { value: "Save the Children", label: "Save the Children" },
  { value: "Sea Shepherd Conservation Society", label: "Sea Shepherd Conservation Society" },
  { value: "St. Jude Children's Research Hospital", label: "St. Jude Children's Research Hospital" },
  { value: "Young Lives vs Cancer", label: "Young Lives vs Cancer" },
];


export default function DesktopUpload({ 
  hasActiveCycle,
  showSupportLink,
  forceSuccessState = false,
  socialSettings,
  participationState,
  showDiscordSyncDelayNotice,
  currentCycleStatus,
  pausedFromStatus,
}: {
  hasActiveCycle: boolean;
  showSupportLink: boolean;
  forceSuccessState?: boolean;
  socialSettings: UserSocialSettings;
  participationState: ParticipationAccessState;
  showDiscordSyncDelayNotice: boolean;
  currentCycleStatus: string | null;
  pausedFromStatus: string | null;
}) {

  const { openOverlay } = useOverlay();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAttemptKeyRef = useRef<string | null>(null);
  const [uploadDone, setUploadDone] = useState(forceSuccessState);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [payoutChoice, setPayoutChoice] = useState<PayoutChoice | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [charity, setCharity] = useState<string | null>(null);
  const [customCharity, setCustomCharity] = useState("");
  const [successMode, setSuccessMode] = useState<"success" | "already">("success");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rulesStatus, setRulesStatus] = useState<
  "unknown" | "checking" | "needsAccept" | "accepted"
>("unknown");
  

useEffect(() => {
  if (forceSuccessState) {
    setSuccessMode("already");
  }
}, [forceSuccessState]);

  const hasImage = !!file;
  const canUseForm =
    participationState.status === "eligible" ||
    participationState.status === "join_wait";
  const canSubmit = participationState.status === "eligible";
  const refreshEligibility = useCallback(() => {
    router.refresh();
  }, [router]);
  const walletDisabled = payoutChoice === "donate";
  const walletRequired =
    payoutChoice === "keep" || payoutChoice === "split";
  const hasMeta =
    !!payoutChoice &&
    (!walletRequired || !!walletAddress.trim()) &&
    (payoutChoice !== "split" || splitPercent > 0) &&
    (payoutChoice === "keep" || charity);

  const submitState: SubmitState =
  hasImage && hasMeta ? "ready" : hasImage || hasMeta ? "partial" : "idle";

  const uploadUnavailableMessage = (() => {
    if (currentCycleStatus === "voting_open") {
      return {
        title: "Submissions are closed",
        text: "The voting phase is active now. Submissions open again when the next cycle starts.",
      };
    }

    if (currentCycleStatus === "submission_closed") {
      return {
        title: "Submission phase ended",
        text: "Voting will begin shortly. Submissions open again when the next cycle starts.",
      };
    }

    if (currentCycleStatus === "paused") {
      return pausedFromStatus === "submission_open"
        ? {
            title: "Submission phase paused",
            text: "Uploads are temporarily paused and will continue when the cycle resumes.",
          }
        : {
            title: "Cycle paused",
            text: "Voting is temporarily paused. Submissions open again with the next cycle.",
          };
    }

    if (
      currentCycleStatus === "voting_closed" ||
      currentCycleStatus === "finalizing"
    ) {
      return {
        title: "This cycle is wrapping up",
        text: "Voting has ended. Submissions open again when the next cycle starts.",
      };
    }

    return {
      title: "No active cycle right now.",
      text: "Uploads open again automatically as soon as the next cycle starts.",
    };
  })();

useEffect(() => {
  if (!hasActiveCycle) return;
  if (!canSubmit) return;
  if (submitState !== "ready") return;
  if (rulesStatus !== "unknown") return;

  const checkRules = async () => {
    setRulesStatus("checking");

    const res = await fetch("/api/upload/check-rules");
    const data = await res.json();

    if (!res.ok) {
      setRulesStatus("unknown");
      return;
    }

    if (!data.needsAccept) {
      setRulesStatus("accepted");
    } else {
      setRulesStatus("needsAccept");
      openOverlay(
  <RulesOverlay
    isFirstAccept={data.isFirstAccept}
    updatedAt={data.updatedAt}
    onConfirm={async () => {
      await fetch("/api/upload/confirm-rules", {
        method: "POST",
      });
      setRulesStatus("accepted");
    }}
    onCancel={() => {
      setRulesStatus("unknown");
    }}
  />
);
    }
  };

  checkRules();
}, [canSubmit, hasActiveCycle, openOverlay, rulesStatus, submitState]);
  const submitImage =
  submitState === "ready"
    ? "https://cdn.cancerculture.fun/webp/submit.confirm/sub3.webp"
    : submitState === "partial"
    ? "https://cdn.cancerculture.fun/webp/submit.confirm/sub2.webp"
    : "https://cdn.cancerculture.fun/webp/submit.confirm/sub1.webp";


  const handleScannerClick = () => {
    if (!hasActiveCycle || !canUseForm) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;

    const validationError = await preflightBrowserImage(
      f,
      SUBMISSION_MEDIA_PROFILE
    );
    if (validationError) {
      alert(MEDIA_VALIDATION_MESSAGES[validationError]);
      e.target.value = "";
      return;
    }

    uploadAttemptKeyRef.current = null;
    setFile(f);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(f);
    });
  };

  const handleSubmit = async () => {
  if (!hasActiveCycle) return;
  if (!canSubmit) return;
  if (
    submitState !== "ready" ||
    isSubmitting ||
    rulesStatus !== "accepted"
  ) return;

    setIsSubmitting(true);
   

    try {
      const formData = new FormData();
      formData.append("file", file!);
      formData.append(
        "walletAddress",
        walletRequired ? walletAddress : ""
      );
      formData.append("payoutChoice", payoutChoice!);
      formData.append("splitPercent", splitPercent.toString());
      if (charity === "other") formData.append("charity", customCharity);
      else if (charity) formData.append("charity", charity);

if (!file) {
  alert("No file selected");
  return;
}

      const res = await fetch("/api/upload", {
        method: "POST",
        headers: {
          "Idempotency-Key":
            uploadAttemptKeyRef.current ??
            (uploadAttemptKeyRef.current = crypto.randomUUID()),
        },
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
  if (
    data.error === "NOT_IN_DISCORD" ||
    data.error === "JOINED_TOO_RECENTLY" ||
    data.error === "MEMBERSHIP_PENDING" ||
    data.error === "MEMBERSHIP_UNAVAILABLE"
  ) {
    router.refresh();
    return;
  }

  const mediaMessage =
    typeof data.error === "string" && data.error in MEDIA_VALIDATION_MESSAGES
      ? MEDIA_VALIDATION_MESSAGES[
          data.error as keyof typeof MEDIA_VALIDATION_MESSAGES
        ]
      : null;
  alert(mediaMessage ?? data.error ?? "Upload not possible right now");
  return;
}

      setSuccessMode("success");
      setUploadDone(true);
    } catch {
      alert(
        "The upload result could not be confirmed. Retry without changing the form; the same request key will be reused safely."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!canUseForm) {
    return (
      <div className="px-6 py-28">
        <div className="mx-auto max-w-xl rounded-[2rem] bg-yellow-star px-8 py-10 text-center shadow-[0_18px_60px_rgba(0,0,0,0.16)]">
          {participationState.status === "anonymous" ? (
            <>
              <a
                href="/api/auth/discord/login?state=/upload"
                className="inline-flex rounded-xl bg-black px-6 py-3 text-yellow-300"
              >
                Login with Discord to upload
              </a>
              <p className="mt-5 text-sm text-[var(--orange-main)]/80">
                To upload or vote, you must be a member of our Discord for at least 10 minutes. This helps us reduce spam and abuse.
              </p>
            </>
          ) : participationState.status === "not_in_discord" ? (
            <>
              {showDiscordSyncDelayNotice ? (
                <DiscordSyncDelayNotice className="mb-5 text-sm text-[var(--orange-main)]" />
              ) : null}
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded-xl bg-black px-6 py-3 text-yellow-300"
              >
                Join Discord to participate
              </a>
              <p className="mt-5 text-sm text-[var(--orange-main)]/80">
                After joining, you need 10 minutes of actual Discord membership before uploading or voting.
              </p>
            </>
          ) : participationState.status === "membership_pending" ? (
            showDiscordSyncDelayNotice ? (
              <DiscordSyncDelayNotice className="text-sm text-[var(--orange-main)]" />
            ) : (
              <p className="text-[var(--orange-main)]">
                We&apos;re temporarily verifying your Discord membership
              </p>
            )
          ) : participationState.status === "restricted" ? (
            <p className="text-red-700">Account restricted</p>
          ) : (
            <p className="text-[var(--orange-main)]">
              Temporarily unable to verify membership
            </p>
          )}
        </div>
      </div>
    );
  }

 
  return (
    <div className="py-24">
      <div className="max-w-6xl mx-auto px-6 flex flex-col gap-14">

        {participationState.status === "join_wait" ? (
          <div className="mx-auto flex max-w-xl flex-col items-center gap-2 rounded-2xl bg-black/75 px-6 py-4 text-center text-white">
            <span>You can prepare your submission while the join wait finishes.</span>
            <DiscordCooldownTimer
              joinedAt={participationState.joinedAt}
              onComplete={refreshEligibility}
              className="font-mono text-2xl text-orange-400"
            />
          </div>
        ) : null}

        
        {!uploadDone &&
          (hasActiveCycle ? (
            <>
            
            <div className="flex flex-col items-center gap-4">
              <span className="upload-hint animate-soft-hint">
                Drop your meme
              </span>
              <div className="upload-hint animate-soft-hint leading-none">
      ↓
    </div>

              <div className="bg-yellow-star rounded-3xl p-10">
                <ScannerDisplay
  hasPreview={!!previewUrl}
  onClick={handleScannerClick}
/>
              </div>
            </div>

            {previewUrl && (
              <div className="mx-auto bg-white rounded-xl p-2 shadow-xl">
                <Image
                  src={previewUrl}
                  alt="Preview"
                  width={260}
                  height={260}
                  unoptimized
                  className="h-[260px] w-[260px] rounded-lg object-contain"
                />
              </div>
            )}



            
            <div className="mx-auto w-full max-w-xl bg-yellow-star rounded-3xl p-8 flex flex-col gap-5">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="font-[Permanent_Marker] text-[var(--orange-dark)]">
                {socialSettings.socialCount === 0 ? (
                  <span>
                    No socials connected yet.
                  </span>
                ) : socialSettings.showSocialsOnSubmissions &&
                  socialSettings.verifiedSocialCount > 0 ? (
                  <span>
                    Your verified socials will show on revealed submissions.
                  </span>
                ) : socialSettings.showSocialsOnSubmissions ? (
                  <span>
                    Submission socials are enabled, but you have no verified socials yet.
                  </span>
                ) : (
                  <span>
                    Your socials are currently hidden for submissions.
                  </span>
                )}
                </div>

                {socialSettings.showSocialsOnSubmissions &&
                socialSettings.socialPlatforms.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    {socialSettings.socialPlatforms.map((platform, index) => (
                      <SocialPlatformBadge
                        key={`${platform}-${index}`}
                        platform={platform}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              {!walletDisabled ? (
                <input
                  placeholder="Wallet address"
                  value={walletAddress}
                  onChange={(e) => {
                    uploadAttemptKeyRef.current = null;
                    setWalletAddress(e.target.value);
                  }}
                  className="rounded-xl px-4 py-2 bg-white"
                />
              ) : (
                <div className="text-center font-[Permanent_Marker] text-[var(--orange-dark)]">
                  Clean move. We respect that!
                </div>
              )}

              <div className="flex gap-3">
                {["keep", "donate", "split"].map((o) => (
                  <button
                    key={o}
                    onClick={() => {
                      uploadAttemptKeyRef.current = null;
                      const nextChoice = o as PayoutChoice;
                      setPayoutChoice(nextChoice);
                      if (nextChoice === "donate") {
                        setWalletAddress("");
                      }
                    }}
                    className={`flex-1 py-2 rounded-xl cursor-pointer transition ${
                      payoutChoice === o
                        ? "bg-black text-yellow-300"
                        : "bg-white"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>

              {payoutChoice === "split" && (
            <div className="flex flex-col gap-2">
              <input
                type="range"
                min={1}
                max={99}
                value={splitPercent}
                onChange={(e) => {
                  uploadAttemptKeyRef.current = null;
                  setSplitPercent(Number(e.target.value));
                }}
              />
              <div className="flex justify-between text-sm text-[var(--orange-main)]">
                <span>You: {splitPercent}%</span>
                <span>Charity: {100 - splitPercent}%</span>
              </div>
            </div>
          )}

              {(payoutChoice === "donate" || payoutChoice === "split") && (
                <>
                  <select
                    value={charity ?? ""}
                    onChange={(e) => {
                      uploadAttemptKeyRef.current = null;
                      setCharity(e.target.value);
                    }}
                    className="rounded-xl px-4 py-2 bg-white"
                  >
                    <option value="" disabled>
                      Select charity
                    </option>
                    {CHARITY_OPTIONS.map((org) => (
                      <option key={org.value} value={org.value}>
                        {org.label}
                      </option>
                    ))}
                    <option value="other">Other</option>
                  </select>

                  {charity === "other" && (
                    <input
                      placeholder="Custom charity"
                      value={customCharity}
                      onChange={(e) => {
                        uploadAttemptKeyRef.current = null;
                        setCustomCharity(e.target.value);
                      }}
                      className="rounded-xl px-4 py-2 bg-white"
                    />
                  )}
                  
<div className="relative flex justify-center">
  {(payoutChoice === "donate" || payoutChoice === "split") && (
    <button
  type="button"
  onClick={() => openOverlay(<CharitiesOverlay />)}
  className="
    text-sm
    text-[var(--orange-main)]
    font-['Permanent_Marker']
    opacity-80
    hover:opacity-100
    underline
    underline-offset-4
    transition
    cursor-pointer
  "
>
  Not sure? Learn more about the charities
</button>
  )}
</div>
                </>
              )}
            </div>

            
{canSubmit && submitState === "ready" && rulesStatus === "accepted" && (
  <div className="text-center mt-4">
                <span className="upload-hint animate-soft-hint">
                  Hit it
                </span>
                <div className="upload-hint animate-soft-hint leading-none">
      ↓
    </div>
              </div>
            )}
          </>
          ) : (
            <div className="mx-auto w-full max-w-2xl rounded-[2rem] bg-yellow-star px-8 py-10 text-center shadow-[0_18px_60px_rgba(0,0,0,0.16)]">
              <div className="font-[Permanent_Marker] text-3xl text-[var(--orange-dark)]">
                {uploadUnavailableMessage.title}
              </div>
              <p className="mt-4 text-base text-[var(--orange-main)]">
                {uploadUnavailableMessage.text}
              </p>
            </div>
          ))}

        
        {!uploadDone && hasActiveCycle ? (
          <div
  onClick={handleSubmit}
  className={`mx-auto ${
    hasActiveCycle &&
    canSubmit &&
    submitState === "ready" &&
    rulesStatus === "accepted"
      ? "cursor-pointer"
      : "opacity-60"
  }`}
>
            <Image
              src={submitImage}
              alt="Submit"
              width={260}
              height={260}
            />
          </div>
        ) : uploadDone ? (
          <div
            className="mx-auto cursor-pointer"
            onClick={() => (location.href = "/")}
          >
            <HomeBlinkCell mode={successMode} />

          </div>
        ) : null}

        
        {showSupportLink && (
          <div className="mt-10 flex flex-col items-center gap-1">
            <span className="upload-hint animate-soft-hint text-xs">
              Problem?
            </span>
            <a
              href="https://tally.so/r/7RLXOZ"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 rounded-full bg-black/70 text-white text-xs"
            >
              Wallet / Participation Issue?
            </a>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={SUBMISSION_MEDIA_PROFILE.allowedBrowserMimeTypes.join(",")}
          hidden
          onChange={handleFileChange}
          disabled={!hasActiveCycle || !canUseForm}
        />
      </div>
  

    
    </div>
  );
}
