import type { ReportReason } from "@daily-quiz-battle/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { createQuestionReport } from "./lib/api";
import { logAnalyticsEvent } from "./lib/platform";

const reasonOptions: ReadonlyArray<{
  value: ReportReason;
  label: string;
}> = [
  { value: "incorrect_answer", label: "정답이 잘못됐어요" },
  { value: "ambiguous", label: "문제나 보기가 모호해요" },
  { value: "outdated", label: "정보가 오래됐어요" },
  { value: "inappropriate", label: "부적절한 내용이 있어요" },
  { value: "other", label: "기타" },
];

type SubmissionStatus =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

interface QuestionReportProps {
  sequence: number;
  questionRevisionId: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}

export function QuestionReport({
  sequence,
  questionRevisionId,
  open,
  onOpen,
  onClose,
  onPendingChange,
}: QuestionReportProps) {
  const formId = useId();
  const firstReasonRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocusRef = useRef(false);
  const submittingRef = useRef(false);
  const submissionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState("");
  const [status, setStatus] = useState<SubmissionStatus>({ kind: "idle" });

  useEffect(() => {
    if (open) {
      firstReasonRef.current?.focus();
    } else if (restoreTriggerFocusRef.current) {
      restoreTriggerFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submissionAbortRef.current?.abort();
      submissionAbortRef.current = null;
      if (submittingRef.current) {
        submittingRef.current = false;
        onPendingChange(false);
      }
    };
  }, [onPendingChange]);

  const resetAndClose = () => {
    setReason(null);
    setDetail("");
    setStatus({ kind: "idle" });
    restoreTriggerFocusRef.current = true;
    onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason === null || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    submissionAbortRef.current = controller;
    onPendingChange(true);
    setStatus({ kind: "busy", message: "신고를 제출하고 있어요." });

    try {
      const trimmedDetail = detail.trim();
      const response = await createQuestionReport(
        {
          questionRevisionId,
          reasonCode: reason,
          detail: trimmedDetail.length > 0 ? trimmedDetail : undefined,
        },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) {
        return;
      }
      setStatus({
        kind: "success",
        message: response.deduplicated
          ? "이미 접수된 신고예요. 기존 신고를 확인하고 있어요."
          : "신고를 접수했어요. 검토 후 반영할게요.",
      });
      void logAnalyticsEvent("question_report", { reason });
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) {
        return;
      }
      setStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "신고를 제출하지 못했어요. 다시 시도해 주세요.",
      });
    } finally {
      if (submissionAbortRef.current === controller) {
        submissionAbortRef.current = null;
        submittingRef.current = false;
        onPendingChange(false);
      }
    }
  };

  if (!open) {
    return (
      <button
        ref={triggerRef}
        className="question-report-trigger"
        type="button"
        aria-expanded="false"
        aria-controls={formId}
        onClick={onOpen}
      >
        문제 신고
      </button>
    );
  }

  const busy = status.kind === "busy";

  return (
    <form
      className="question-report-form"
      id={formId}
      aria-label={`문제 ${sequence} 신고`}
      aria-busy={busy}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <fieldset disabled={busy}>
        <legend>신고 이유</legend>
        <div className="question-report-reasons">
          {reasonOptions.map((option, index) => (
            <label key={option.value}>
              <input
                ref={index === 0 ? firstReasonRef : undefined}
                type="radio"
                name={`${formId}-reason`}
                value={option.value}
                checked={reason === option.value}
                onChange={() => {
                  setReason(option.value);
                  setStatus({ kind: "idle" });
                }}
                required
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>

        <label className="question-report-detail" htmlFor={`${formId}-detail`}>
          상세 내용 <span>(선택)</span>
        </label>
        <textarea
          id={`${formId}-detail`}
          aria-describedby={`${formId}-detail-help ${formId}-detail-count`}
          value={detail}
          maxLength={500}
          rows={4}
          onChange={(event) => {
            setDetail(event.target.value);
            setStatus({ kind: "idle" });
          }}
          placeholder="검토에 도움이 되는 내용을 적어 주세요."
        />
        <small id={`${formId}-detail-help`}>
          이름, 연락처 등 개인정보는 입력하지 마세요.
        </small>
        <small id={`${formId}-detail-count`} className="question-report-count">
          {detail.length} / 500자
        </small>
      </fieldset>

      <div className="question-report-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={resetAndClose}
        >
          취소
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || reason === null}
        >
          {busy ? "제출 중…" : "신고 제출"}
        </button>
      </div>

      {status.kind !== "idle" ? (
        <p
          className={`question-report-status question-report-status-${status.kind}`}
          role={status.kind === "error" ? "alert" : "status"}
          aria-live={status.kind === "error" ? "assertive" : "polite"}
        >
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
