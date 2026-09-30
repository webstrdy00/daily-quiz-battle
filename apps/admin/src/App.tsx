import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AdminAuditLogListItem,
  AdminCreateDailySetDraftRequest,
  AdminCreateQuestionRevisionRequest,
  AdminDailySetListEntry,
  AdminQuestionRevisionListItem,
  AdminReportListItem,
  ChoiceOrder,
  ContentStatus,
  DailySetStatus,
  ReportReason,
  ReportStatus,
  ReportTriageStatus,
} from "@daily-quiz-battle/contracts";
import {
  AdminApiClient,
  ApiClientError,
  type AuditLogQuery,
  type ReportQuery,
} from "./lib/api";

interface UiIssue {
  message: string;
  requestId?: string;
}

interface PendingPublish {
  dailySetId: string;
  quizDate: string;
  version: number;
}

type PendingVoid = PendingPublish;

interface LatestDraft extends PendingPublish {
  published: boolean;
}

interface CorrectionSource {
  questionId: string;
  revisionId: string;
  revisionNumber: number;
  prompt: string;
}

interface PendingReportDismiss {
  reportId: string;
}

const CONTENT_STATUSES: readonly ContentStatus[] = [
  "draft",
  "review",
  "approved",
  "published",
  "retired",
];

const DAILY_SET_STATUSES: readonly DailySetStatus[] = [
  "draft",
  "published",
  "retired",
];

const STATUS_LABEL: Record<ContentStatus | DailySetStatus, string> = {
  draft: "초안",
  review: "검토 중",
  approved: "승인됨",
  published: "게시됨",
  retired: "폐기됨",
};

const NEXT_STATUSES: Record<ContentStatus, readonly ContentStatus[]> = {
  draft: ["review"],
  review: ["draft", "approved"],
  approved: ["draft", "published"],
  published: ["retired"],
  retired: [],
};

const REPORT_STATUSES: readonly ReportStatus[] = [
  "open",
  "reviewing",
  "resolved",
  "dismissed",
];

const REPORT_REASONS: readonly ReportReason[] = [
  "incorrect_answer",
  "ambiguous",
  "outdated",
  "inappropriate",
  "other",
];

const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: "접수",
  reviewing: "검토 중",
  resolved: "해결",
  dismissed: "기각",
};

const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  incorrect_answer: "정답 오류",
  ambiguous: "모호함",
  outdated: "오래된 정보",
  inappropriate: "부적절한 내용",
  other: "기타",
};

const REPORT_NEXT_STATUSES: Record<
  ReportStatus,
  readonly ReportTriageStatus[]
> = {
  open: ["reviewing", "resolved", "dismissed"],
  reviewing: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

const DEFAULT_CHOICE_ORDER: ChoiceOrder = [0, 1, 2, 3];
const CHOICE_ORDERS: readonly ChoiceOrder[] = [
  [0, 1, 2, 3],
  [0, 1, 3, 2],
  [0, 2, 1, 3],
  [0, 2, 3, 1],
  [0, 3, 1, 2],
  [0, 3, 2, 1],
  [1, 0, 2, 3],
  [1, 0, 3, 2],
  [1, 2, 0, 3],
  [1, 2, 3, 0],
  [1, 3, 0, 2],
  [1, 3, 2, 0],
  [2, 0, 1, 3],
  [2, 0, 3, 1],
  [2, 1, 0, 3],
  [2, 1, 3, 0],
  [2, 3, 0, 1],
  [2, 3, 1, 0],
  [3, 0, 1, 2],
  [3, 0, 2, 1],
  [3, 1, 0, 2],
  [3, 1, 2, 0],
  [3, 2, 0, 1],
  [3, 2, 1, 0],
];

function dateInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function futureDateInput(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateInputValue(date);
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return "—";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toUiIssue(error: unknown): UiIssue {
  if (error instanceof ApiClientError) {
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "요청을 처리하지 못했습니다." };
}

function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function localDateTimeToIso(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new ApiClientError({
      code: "INVALID_DATE_TIME",
      message: "날짜와 시간을 다시 확인해 주세요.",
    });
  }
  return date.toISOString();
}

function ErrorNotice({
  issue,
  onRetry,
}: {
  issue: UiIssue;
  onRetry?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [issue]);

  return (
    <div className="notice error-notice" role="alert" tabIndex={-1} ref={ref}>
      <strong>요청 실패</strong>
      <span>{issue.message}</span>
      {issue.requestId ? <small>요청 ID: {issue.requestId}</small> : null}
      {onRetry ? (
        <button type="button" className="secondary-button" onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}

export default function App() {
  const clientRef = useRef<AdminApiClient | null>(null);
  const mountedRef = useRef(true);
  const publishConfirmRef = useRef<HTMLButtonElement>(null);
  const voidReasonRef = useRef<HTMLTextAreaElement>(null);
  const reportDismissCancelRef = useRef<HTMLButtonElement>(null);
  const reportDismissTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reportSuccessRef = useRef<HTMLParagraphElement>(null);
  const revisionCreatePanelRef = useRef<HTMLDetailsElement>(null);
  const questionIdInputRef = useRef<HTMLInputElement>(null);

  const [connected, setConnected] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginIssue, setLoginIssue] = useState<UiIssue | null>(null);

  const [revisions, setRevisions] = useState<AdminQuestionRevisionListItem[]>(
    [],
  );
  const [revisionStatus, setRevisionStatus] = useState<ContentStatus | "">("");
  const [revisionCursor, setRevisionCursor] = useState<string | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionIssue, setRevisionIssue] = useState<UiIssue | null>(null);
  const [revisionActionBusy, setRevisionActionBusy] = useState<string | null>(
    null,
  );
  const [revisionActionIssue, setRevisionActionIssue] =
    useState<UiIssue | null>(null);
  const [revisionSuccess, setRevisionSuccess] = useState("");
  const [timeSensitive, setTimeSensitive] = useState(false);
  const [revisionCreateOpen, setRevisionCreateOpen] = useState(false);
  const [questionIdInput, setQuestionIdInput] = useState("");
  const [correctionSource, setCorrectionSource] =
    useState<CorrectionSource | null>(null);

  const [publishedRevisions, setPublishedRevisions] = useState<
    AdminQuestionRevisionListItem[]
  >([]);
  const [publishedCursor, setPublishedCursor] = useState<string | null>(null);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedIssue, setPublishedIssue] = useState<UiIssue | null>(null);
  const [selectedRevisionIds, setSelectedRevisionIds] = useState<string[]>([]);
  const [choiceOrders, setChoiceOrders] = useState<Record<string, ChoiceOrder>>(
    {},
  );

  const [dailyFrom, setDailyFrom] = useState(() => dateInputValue(new Date()));
  const [dailyTo, setDailyTo] = useState(() => futureDateInput(30));
  const [dailyStatus, setDailyStatus] = useState<DailySetStatus | "">("");
  const [dailySets, setDailySets] = useState<AdminDailySetListEntry[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyIssue, setDailyIssue] = useState<UiIssue | null>(null);
  const [dailyActionBusy, setDailyActionBusy] = useState(false);
  const [dailyActionIssue, setDailyActionIssue] = useState<UiIssue | null>(
    null,
  );
  const [dailySuccess, setDailySuccess] = useState("");
  const [draftDate, setDraftDate] = useState(() => dateInputValue(new Date()));
  const [latestDraft, setLatestDraft] = useState<LatestDraft | null>(null);
  const [pendingPublish, setPendingPublish] = useState<PendingPublish | null>(
    null,
  );
  const [pendingVoid, setPendingVoid] = useState<PendingVoid | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidActionBusy, setVoidActionBusy] = useState(false);
  const [voidActionIssue, setVoidActionIssue] = useState<UiIssue | null>(null);

  const [auditLogs, setAuditLogs] = useState<AdminAuditLogListItem[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditIssue, setAuditIssue] = useState<UiIssue | null>(null);

  const [reports, setReports] = useState<AdminReportListItem[]>([]);
  const [reportStatus, setReportStatus] = useState<ReportStatus | "">("");
  const [reportReason, setReportReason] = useState<ReportReason | "">("");
  const [reportCursor, setReportCursor] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportIssue, setReportIssue] = useState<UiIssue | null>(null);
  const [reportActionBusy, setReportActionBusy] = useState<string | null>(null);
  const [reportActionIssue, setReportActionIssue] = useState<UiIssue | null>(
    null,
  );
  const [reportSuccess, setReportSuccess] = useState("");
  const [pendingReportDismiss, setPendingReportDismiss] =
    useState<PendingReportDismiss | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (pendingPublish === null) {
      return;
    }
    publishConfirmRef.current?.focus();
  }, [pendingPublish]);

  useEffect(() => {
    if (pendingVoid === null) {
      return;
    }
    voidReasonRef.current?.focus();
  }, [pendingVoid]);

  useEffect(() => {
    if (pendingReportDismiss === null) {
      return;
    }
    reportDismissCancelRef.current?.focus();
  }, [pendingReportDismiss]);

  useEffect(() => {
    if (!reportSuccess) {
      return;
    }
    reportSuccessRef.current?.focus();
  }, [reportSuccess]);

  useEffect(() => {
    if (!revisionCreateOpen || correctionSource === null) {
      return;
    }
    revisionCreatePanelRef.current?.scrollIntoView({
      behavior: "auto",
      block: "start",
    });
    questionIdInputRef.current?.focus();
  }, [correctionSource, revisionCreateOpen]);

  function clearSession(issue?: UiIssue): void {
    clientRef.current?.dispose();
    clientRef.current = null;
    setTokenInput("");
    setConnected(false);
    setLoginBusy(false);
    setLoginIssue(issue ?? null);
    setRevisions([]);
    setRevisionCursor(null);
    setRevisionLoading(false);
    setRevisionIssue(null);
    setRevisionActionBusy(null);
    setRevisionActionIssue(null);
    setRevisionSuccess("");
    setTimeSensitive(false);
    setPublishedRevisions([]);
    setPublishedCursor(null);
    setPublishedLoading(false);
    setPublishedIssue(null);
    setSelectedRevisionIds([]);
    setChoiceOrders({});
    setRevisionCreateOpen(false);
    setQuestionIdInput("");
    setCorrectionSource(null);
    setDailySets([]);
    setDailyLoading(false);
    setDailyIssue(null);
    setDailyActionBusy(false);
    setDailyActionIssue(null);
    setDailySuccess("");
    setLatestDraft(null);
    setPendingPublish(null);
    setPendingVoid(null);
    setVoidReason("");
    setVoidActionBusy(false);
    setVoidActionIssue(null);
    setAuditLogs([]);
    setAuditCursor(null);
    setAuditLoading(false);
    setAuditIssue(null);
    setReports([]);
    setReportCursor(null);
    setReportLoading(false);
    setReportIssue(null);
    setReportActionBusy(null);
    setReportActionIssue(null);
    setReportSuccess("");
    setPendingReportDismiss(null);
    reportDismissTriggerRef.current = null;
  }

  function handleFailure(
    error: unknown,
    client: AdminApiClient,
    setIssue: (issue: UiIssue) => void,
  ): void {
    if (!mountedRef.current || clientRef.current !== client) {
      return;
    }
    const issue = toUiIssue(error);
    if (error instanceof ApiClientError && error.status === 401) {
      clearSession({
        message:
          "운영자 JWT가 만료되었거나 유효하지 않습니다. 새 토큰을 입력해 주세요.",
        requestId: error.requestId,
      });
      return;
    }
    setIssue(issue);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginIssue(null);
    setLoginBusy(true);

    let client: AdminApiClient;
    try {
      client = new AdminApiClient(tokenInput, () => {
        if (!mountedRef.current || clientRef.current !== client) return;
        clearSession({
          message: "운영자 JWT가 만료되었습니다. 새 토큰을 입력해 주세요.",
        });
      });
    } catch (error) {
      setTokenInput("");
      setLoginBusy(false);
      setLoginIssue(toUiIssue(error));
      return;
    }

    clientRef.current?.dispose();
    clientRef.current = client;
    setTokenInput("");

    try {
      const firstPage = await client.listQuestionRevisions({ limit: 20 });
      if (!mountedRef.current || clientRef.current !== client) {
        return;
      }
      setRevisions(firstPage.questionRevisions);
      setRevisionCursor(firstPage.nextCursor);
      setConnected(true);
      setLoginBusy(false);
      void loadPublishedRevisions(false, client);
      void loadDailySets(client);
      void loadAuditLogs(false, client);
      void loadReports(false, client);
    } catch (error) {
      if (!mountedRef.current || clientRef.current !== client) return;
      clearSession(toUiIssue(error));
    }
  }

  async function loadRevisions(
    append: boolean,
    client = clientRef.current,
  ): Promise<void> {
    if (client === null) return;
    setRevisionLoading(true);
    setRevisionIssue(null);
    try {
      const response = await client.listQuestionRevisions({
        ...(revisionStatus ? { status: revisionStatus } : {}),
        ...(append && revisionCursor ? { cursor: revisionCursor } : {}),
        limit: 20,
      });
      if (clientRef.current !== client) return;
      setRevisions((current) =>
        append
          ? [
              ...current,
              ...response.questionRevisions.filter(
                (item) =>
                  !current.some(
                    (existing) => existing.revisionId === item.revisionId,
                  ),
              ),
            ]
          : response.questionRevisions,
      );
      setRevisionCursor(response.nextCursor);
    } catch (error) {
      handleFailure(error, client, setRevisionIssue);
    } finally {
      if (clientRef.current === client) setRevisionLoading(false);
    }
  }

  async function loadPublishedRevisions(
    append: boolean,
    client = clientRef.current,
  ): Promise<void> {
    if (client === null) return;
    setPublishedLoading(true);
    setPublishedIssue(null);
    try {
      const response = await client.listQuestionRevisions({
        status: "published",
        ...(append && publishedCursor ? { cursor: publishedCursor } : {}),
        limit: 100,
      });
      if (clientRef.current !== client) return;
      setPublishedRevisions((current) =>
        append
          ? [
              ...current,
              ...response.questionRevisions.filter(
                (item) =>
                  !current.some(
                    (existing) => existing.revisionId === item.revisionId,
                  ),
              ),
            ]
          : response.questionRevisions,
      );
      if (!append) {
        setSelectedRevisionIds([]);
        setChoiceOrders({});
      }
      setPublishedCursor(response.nextCursor);
    } catch (error) {
      handleFailure(error, client, setPublishedIssue);
    } finally {
      if (clientRef.current === client) setPublishedLoading(false);
    }
  }

  function startCorrection(source: CorrectionSource): void {
    setCorrectionSource(source);
    setQuestionIdInput(source.questionId);
    setRevisionCreateOpen(true);
    setRevisionActionIssue(null);
    setRevisionSuccess("");
  }

  function startReportCorrection(report: AdminReportListItem): void {
    if (report.questionContext === null) {
      return;
    }
    startCorrection(report.questionContext);
  }

  async function createRevision(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const client = clientRef.current;
    if (client === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setRevisionActionBusy("create");
    setRevisionActionIssue(null);
    setRevisionSuccess("");

    try {
      const sensitive = data.get("timeSensitive") === "on";
      const questionId = formString(data, "questionId");
      const request: AdminCreateQuestionRevisionRequest = {
        ...(questionId ? { questionId } : {}),
        category: formString(data, "category"),
        difficulty: formString(
          data,
          "difficulty",
        ) as AdminCreateQuestionRevisionRequest["difficulty"],
        prompt: formString(data, "prompt"),
        choices: [
          formString(data, "choice0"),
          formString(data, "choice1"),
          formString(data, "choice2"),
          formString(data, "choice3"),
        ],
        correctIndex: Number(
          formString(data, "correctIndex"),
        ) as AdminCreateQuestionRevisionRequest["correctIndex"],
        explanation: formString(data, "explanation"),
        sourceUrl: formString(data, "sourceUrl"),
        sourceCheckedAt: localDateTimeToIso(
          formString(data, "sourceCheckedAt"),
        ),
        reviewerId: formString(data, "reviewerId"),
        timeSensitive: sensitive,
        validUntil: sensitive
          ? localDateTimeToIso(formString(data, "validUntil"))
          : null,
        nextReviewAt: sensitive
          ? localDateTimeToIso(formString(data, "nextReviewAt"))
          : null,
      };
      const result = await client.createQuestionRevision(request);
      if (clientRef.current !== client) return;
      form.reset();
      setTimeSensitive(false);
      setQuestionIdInput("");
      setCorrectionSource(null);
      setRevisionSuccess(
        `리비전 ${result.revisionNumber}이 초안으로 생성되었습니다.`,
      );
      await Promise.all([
        loadRevisions(false, client),
        loadAuditLogs(false, client),
      ]);
    } catch (error) {
      handleFailure(error, client, setRevisionActionIssue);
    } finally {
      if (clientRef.current === client) setRevisionActionBusy(null);
    }
  }

  async function transitionRevision(
    revision: AdminQuestionRevisionListItem,
    status: ContentStatus,
  ): Promise<void> {
    const client = clientRef.current;
    if (client === null) return;
    setRevisionActionBusy(revision.revisionId);
    setRevisionActionIssue(null);
    setRevisionSuccess("");
    try {
      await client.updateQuestionRevisionStatus(revision.revisionId, {
        status,
      });
      if (clientRef.current !== client) return;
      setRevisionSuccess(
        `리비전 상태를 ${STATUS_LABEL[status]}(으)로 변경했습니다.`,
      );
      await Promise.all([
        loadRevisions(false, client),
        loadPublishedRevisions(false, client),
        loadAuditLogs(false, client),
      ]);
    } catch (error) {
      handleFailure(error, client, setRevisionActionIssue);
    } finally {
      if (clientRef.current === client) setRevisionActionBusy(null);
    }
  }

  async function loadDailySets(client = clientRef.current): Promise<void> {
    if (client === null) return;
    setDailyLoading(true);
    setDailyIssue(null);
    try {
      const response = await client.listDailySets({
        from: dailyFrom,
        to: dailyTo,
        ...(dailyStatus ? { status: dailyStatus } : {}),
      });
      if (clientRef.current !== client) return;
      setDailySets(response.dailySets);
    } catch (error) {
      handleFailure(error, client, setDailyIssue);
    } finally {
      if (clientRef.current === client) setDailyLoading(false);
    }
  }

  function toggleRevision(revisionId: string, checked: boolean): void {
    setSelectedRevisionIds((current) => {
      if (!checked) return current.filter((id) => id !== revisionId);
      if (current.includes(revisionId) || current.length >= 5) return current;
      return [...current, revisionId];
    });
    setChoiceOrders((current) => {
      if (!checked) {
        const next = { ...current };
        delete next[revisionId];
        return next;
      }
      return current[revisionId]
        ? current
        : { ...current, [revisionId]: DEFAULT_CHOICE_ORDER };
    });
  }

  async function createDailyDraft(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const client = clientRef.current;
    if (client === null) return;
    setDailyActionIssue(null);
    setDailySuccess("");
    if (selectedRevisionIds.length !== 5) {
      setDailyActionIssue({
        message: "게시된 리비전을 정확히 5개 선택해 주세요.",
      });
      return;
    }

    const items = selectedRevisionIds.map((revisionId) => ({
      revisionId,
      choiceOrder: choiceOrders[revisionId] ?? DEFAULT_CHOICE_ORDER,
    }));
    setDailyActionBusy(true);
    try {
      const response = await client.createDailySetDraft({
        quizDate: draftDate,
        items: items as AdminCreateDailySetDraftRequest["items"],
      });
      if (clientRef.current !== client) return;
      setLatestDraft({
        dailySetId: response.dailySetId,
        quizDate: response.quizDate,
        version: response.version,
        published: false,
      });
      setSelectedRevisionIds([]);
      setChoiceOrders({});
      setDailySuccess(`${response.quizDate} 데일리 세트 초안을 생성했습니다.`);
      await Promise.all([loadDailySets(client), loadAuditLogs(false, client)]);
    } catch (error) {
      handleFailure(error, client, setDailyActionIssue);
    } finally {
      if (clientRef.current === client) setDailyActionBusy(false);
    }
  }

  async function publishDailySet(): Promise<void> {
    const client = clientRef.current;
    const target = pendingPublish;
    if (client === null || target === null) return;
    setDailyActionBusy(true);
    setDailyActionIssue(null);
    setDailySuccess("");
    try {
      const response = await client.publishDailySet(target.dailySetId);
      if (clientRef.current !== client) return;
      setPendingPublish(null);
      setLatestDraft((current) =>
        current?.dailySetId === response.dailySetId
          ? { ...current, published: true }
          : current,
      );
      setDailySuccess(`${response.quizDate} 데일리 세트를 게시했습니다.`);
      await Promise.all([loadDailySets(client), loadAuditLogs(false, client)]);
    } catch (error) {
      handleFailure(error, client, setDailyActionIssue);
    } finally {
      if (clientRef.current === client) setDailyActionBusy(false);
    }
  }

  function openVoidConfirmation(dailySet: AdminDailySetListEntry): void {
    setPendingPublish(null);
    setPendingVoid({
      dailySetId: dailySet.dailySetId,
      quizDate: dailySet.quizDate,
      version: dailySet.version,
    });
    setVoidReason("");
    setVoidActionIssue(null);
    setDailyActionIssue(null);
    setDailySuccess("");
  }

  async function voidDailySet(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const client = clientRef.current;
    const target = pendingVoid;
    if (client === null || target === null) return;

    setVoidActionBusy(true);
    setVoidActionIssue(null);
    setDailySuccess("");
    try {
      const response = await client.voidDailySet(target.dailySetId, {
        reason: voidReason,
      });
      if (clientRef.current !== client) return;
      setPendingVoid(null);
      setVoidReason("");
      setDailySuccess(
        response.replayed
          ? `${target.quizDate} 데일리 세트는 동일 사유로 이미 무효 처리되어 재실행(replay) 응답으로 확인했습니다.`
          : `${target.quizDate} 데일리 세트 결과를 무효 처리했습니다. 과거 점수와 리비전은 변경하거나 재계산하지 않습니다.`,
      );
      await Promise.all([loadDailySets(client), loadAuditLogs(false, client)]);
    } catch (error) {
      handleFailure(error, client, setVoidActionIssue);
    } finally {
      if (clientRef.current === client) setVoidActionBusy(false);
    }
  }

  async function loadAuditLogs(
    append: boolean,
    client = clientRef.current,
  ): Promise<void> {
    if (client === null) return;
    setAuditLoading(true);
    setAuditIssue(null);
    const query: AuditLogQuery = {
      ...(append && auditCursor ? { cursor: auditCursor } : {}),
      limit: 20,
    };
    try {
      const response = await client.listAuditLogs(query);
      if (clientRef.current !== client) return;
      setAuditLogs((current) =>
        append ? [...current, ...response.auditLogs] : response.auditLogs,
      );
      setAuditCursor(response.nextCursor);
    } catch (error) {
      handleFailure(error, client, setAuditIssue);
    } finally {
      if (clientRef.current === client) setAuditLoading(false);
    }
  }

  async function loadReports(
    append: boolean,
    client = clientRef.current,
  ): Promise<void> {
    if (client === null) return;
    setReportLoading(true);
    setReportIssue(null);
    const query: ReportQuery = {
      ...(reportStatus ? { status: reportStatus } : {}),
      ...(reportReason ? { reasonCode: reportReason } : {}),
      ...(append && reportCursor ? { cursor: reportCursor } : {}),
      limit: 20,
    };
    try {
      const response = await client.listReports(query);
      if (clientRef.current !== client) return;
      setReports((current) =>
        append
          ? [
              ...current,
              ...response.reports.filter(
                (report) =>
                  !current.some(
                    (existing) => existing.reportId === report.reportId,
                  ),
              ),
            ]
          : response.reports,
      );
      setReportCursor(response.nextCursor);
    } catch (error) {
      handleFailure(error, client, setReportIssue);
    } finally {
      if (clientRef.current === client) setReportLoading(false);
    }
  }

  function closeReportDismissConfirmation(restoreFocus: boolean): void {
    const trigger = reportDismissTriggerRef.current;
    setPendingReportDismiss(null);
    setReportActionIssue(null);
    reportDismissTriggerRef.current = null;
    if (restoreFocus && trigger) {
      window.requestAnimationFrame(() => trigger.focus());
    }
  }

  async function transitionReport(
    report: AdminReportListItem,
    status: ReportTriageStatus,
  ): Promise<void> {
    if (!REPORT_NEXT_STATUSES[report.status].includes(status)) {
      return;
    }
    const client = clientRef.current;
    if (client === null) return;
    setReportActionBusy(report.reportId);
    setReportActionIssue(null);
    setReportSuccess("");
    try {
      const response = await client.updateReportStatus(report.reportId, {
        status,
      });
      if (clientRef.current !== client) return;
      setReports((current) =>
        current.flatMap((item) => {
          if (item.reportId !== response.reportId) {
            return [item];
          }
          if (reportStatus && reportStatus !== response.status) {
            return [];
          }
          return [
            {
              ...item,
              status: response.status,
              triagedBy: response.triagedBy,
              triagedAt: response.triagedAt,
            },
          ];
        }),
      );
      setReportSuccess(
        `신고 상태를 ${REPORT_STATUS_LABEL[response.status]}(으)로 변경했습니다.`,
      );
      if (status === "dismissed") {
        closeReportDismissConfirmation(false);
      }
      void loadReports(false, client);
    } catch (error) {
      handleFailure(error, client, setReportActionIssue);
    } finally {
      if (clientRef.current === client) setReportActionBusy(null);
    }
  }

  if (!connected) {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="login-title">
          <p className="eyebrow">Daily Quiz Battle</p>
          <h1 id="login-title">운영자 콘텐츠 CMS</h1>
          <div className="environment-warning">
            <strong>Local / Internal 전용</strong>
            <span>Production IAM/SSO 연동 전의 내부 운영 도구입니다.</span>
          </div>
          <p className="muted">
            content:write 권한과 결과 무효 처리 시 content:void 권한이 있는 15분
            admin JWT를 사용합니다. 신고 처리에는 reports:read와 reports:triage
            권한이 필요합니다. 토큰은 이 화면의 메모리에만 유지되며 저장소나
            쿠키에 기록하지 않습니다.
          </p>
          {loginIssue ? <ErrorNotice issue={loginIssue} /> : null}
          <form
            onSubmit={handleLogin}
            autoComplete="off"
            className="login-form"
          >
            <label htmlFor="admin-token">15분 admin JWT</label>
            <input
              id="admin-token"
              name="admin-access-token"
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.currentTarget.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-1p-ignore="true"
              required
              autoFocus
            />
            <button
              className="primary-button"
              type="submit"
              disabled={loginBusy}
            >
              {loginBusy ? "확인 중…" : "메모리 세션 시작"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Daily Quiz Battle</p>
          <h1>운영자 콘텐츠 CMS</h1>
        </div>
        <div className="session-actions">
          <span className="internal-badge">Local / Internal</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => clearSession()}
          >
            로그아웃
          </button>
        </div>
      </header>

      <aside className="security-banner" role="note">
        Production IAM/SSO 연동 전의 내부 UI입니다. JWT는 메모리에만 있으며
        로그아웃 시 즉시 제거됩니다.
      </aside>

      <nav className="section-nav" aria-label="CMS 영역">
        <a href="#question-revisions">문제 리비전</a>
        <a href="#daily-sets">데일리 세트</a>
        <a href="#reports">신고 처리</a>
        <a href="#audit-logs">감사 로그</a>
      </nav>

      <main className="content-grid">
        <section
          id="question-revisions"
          className="panel"
          aria-labelledby="revisions-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Content lifecycle</p>
              <h2 id="revisions-title">문제 리비전</h2>
            </div>
          </div>

          <details
            className="create-panel"
            open={revisionCreateOpen}
            onToggle={(event) =>
              setRevisionCreateOpen(event.currentTarget.open)
            }
            ref={revisionCreatePanelRef}
          >
            <summary>새 리비전 생성</summary>
            <form className="form-grid" onSubmit={createRevision}>
              {correctionSource ? (
                <aside className="correction-guidance full-width" role="note">
                  <strong>r{correctionSource.revisionNumber} 수정 초안</strong>
                  <span>{correctionSource.prompt}</span>
                  <code>{correctionSource.revisionId}</code>
                  <small>
                    기존 Question ID가 자동 입력되었습니다. 저장하면 새 draft
                    revision이 생성되며, 기존 공개 리비전과 과거 결과 점수는
                    수정하거나 재계산하지 않습니다.
                  </small>
                </aside>
              ) : (
                <p className="muted full-width correction-policy">
                  Correction은 같은 Question ID의 새 draft revision으로
                  생성합니다. 기존 공개 리비전과 과거 결과 점수는 수정하거나
                  재계산하지 않습니다.
                </p>
              )}
              <label>
                기존 Question ID <span className="optional">선택</span>
                <input
                  ref={questionIdInputRef}
                  name="questionId"
                  type="text"
                  inputMode="text"
                  value={questionIdInput}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setQuestionIdInput(value);
                    if (
                      correctionSource &&
                      value !== correctionSource.questionId
                    ) {
                      setCorrectionSource(null);
                    }
                  }}
                />
              </label>
              <label>
                카테고리
                <input name="category" type="text" maxLength={32} required />
              </label>
              <label>
                난이도
                <select name="difficulty" defaultValue="medium" required>
                  <option value="easy">쉬움</option>
                  <option value="medium">보통</option>
                  <option value="hard">어려움</option>
                </select>
              </label>
              <label className="full-width">
                문제 문장
                <textarea name="prompt" maxLength={500} rows={3} required />
              </label>
              {[0, 1, 2, 3].map((index) => (
                <label key={index}>
                  선택지 {index}
                  <input name={`choice${index}`} type="text" required />
                </label>
              ))}
              <label>
                정답 선택지
                <select name="correctIndex" defaultValue="0" required>
                  {[0, 1, 2, 3].map((index) => (
                    <option key={index} value={index}>
                      선택지 {index}
                    </option>
                  ))}
                </select>
              </label>
              <label className="full-width">
                해설
                <textarea name="explanation" rows={3} required />
              </label>
              <label className="full-width">
                출처 URL
                <input name="sourceUrl" type="url" required />
              </label>
              <label>
                출처 확인 일시
                <input name="sourceCheckedAt" type="datetime-local" required />
              </label>
              <label>
                검토자 ID
                <input name="reviewerId" type="text" maxLength={100} required />
              </label>
              <label className="checkbox-label full-width">
                <input
                  name="timeSensitive"
                  type="checkbox"
                  checked={timeSensitive}
                  onChange={(event) =>
                    setTimeSensitive(event.currentTarget.checked)
                  }
                />
                시의성 콘텐츠
              </label>
              {timeSensitive ? (
                <>
                  <label>
                    유효 기한
                    <input name="validUntil" type="datetime-local" required />
                  </label>
                  <label>
                    다음 검토 일시
                    <input name="nextReviewAt" type="datetime-local" required />
                  </label>
                </>
              ) : null}
              <div className="form-actions full-width">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={revisionActionBusy !== null}
                >
                  {revisionActionBusy === "create"
                    ? "생성 중…"
                    : "리비전 초안 생성"}
                </button>
              </div>
            </form>
          </details>

          {revisionActionIssue ? (
            <ErrorNotice issue={revisionActionIssue} />
          ) : null}
          {revisionSuccess ? (
            <p className="notice success-notice" role="status">
              {revisionSuccess}
            </p>
          ) : null}

          <form
            className="filter-bar"
            onSubmit={(event) => {
              event.preventDefault();
              void loadRevisions(false);
            }}
          >
            <label htmlFor="revision-status">상태 필터</label>
            <select
              id="revision-status"
              value={revisionStatus}
              onChange={(event) =>
                setRevisionStatus(
                  event.currentTarget.value as ContentStatus | "",
                )
              }
            >
              <option value="">전체</option>
              {CONTENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
            <button
              className="secondary-button"
              type="submit"
              disabled={revisionLoading}
            >
              조회
            </button>
          </form>

          {revisionIssue ? (
            <ErrorNotice
              issue={revisionIssue}
              onRetry={() => void loadRevisions(false)}
            />
          ) : null}
          {revisionLoading && revisions.length === 0 ? (
            <Loading label="리비전 조회 중…" />
          ) : null}
          {!revisionLoading && !revisionIssue && revisions.length === 0 ? (
            <p className="empty-state">조건에 맞는 문제 리비전이 없습니다.</p>
          ) : null}
          <div className="card-list" aria-busy={revisionLoading}>
            {revisions.map((revision) => (
              <article className="revision-card" key={revision.revisionId}>
                <div className="card-title-row">
                  <div>
                    <span className={`status status-${revision.status}`}>
                      {STATUS_LABEL[revision.status]}
                    </span>
                    <span className="meta">
                      {revision.category} · {revision.difficulty} · r
                      {revision.revisionNumber}
                    </span>
                  </div>
                  <code>{revision.revisionId}</code>
                </div>
                <h3>{revision.prompt}</h3>
                <ol className="choice-list" start={0}>
                  {revision.choices.map((choice, index) => (
                    <li
                      key={index}
                      className={
                        index === revision.correctIndex ? "correct" : ""
                      }
                    >
                      {choice}
                      {index === revision.correctIndex ? " (정답)" : ""}
                    </li>
                  ))}
                </ol>
                <p className="explanation">{revision.explanation}</p>
                <dl className="metadata-grid">
                  <div>
                    <dt>Question ID</dt>
                    <dd>
                      <code>{revision.questionId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>검토자</dt>
                    <dd>{revision.reviewerId}</dd>
                  </div>
                  <div>
                    <dt>출처 확인</dt>
                    <dd>{formatDateTime(revision.sourceCheckedAt)}</dd>
                  </div>
                  <div>
                    <dt>다음 검토</dt>
                    <dd>{formatDateTime(revision.nextReviewAt)}</dd>
                  </div>
                </dl>
                <a
                  href={revision.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  referrerPolicy="no-referrer"
                >
                  출처 열기
                </a>
                <div className="button-row" aria-label="리비전 상태 변경">
                  {NEXT_STATUSES[revision.status].map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={
                        status === "retired"
                          ? "danger-button"
                          : "secondary-button"
                      }
                      disabled={revisionActionBusy !== null}
                      onClick={() => void transitionRevision(revision, status)}
                    >
                      {revisionActionBusy === revision.revisionId
                        ? "변경 중…"
                        : `${STATUS_LABEL[status]}(으)로 변경`}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
          {revisionCursor ? (
            <button
              type="button"
              className="secondary-button load-more"
              disabled={revisionLoading}
              onClick={() => void loadRevisions(true)}
            >
              {revisionLoading ? "불러오는 중…" : "다음 리비전 불러오기"}
            </button>
          ) : null}
        </section>

        <section
          id="daily-sets"
          className="panel"
          aria-labelledby="daily-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Schedule</p>
              <h2 id="daily-title">데일리 세트</h2>
            </div>
          </div>

          <form
            className="filter-bar date-filter"
            onSubmit={(event) => {
              event.preventDefault();
              void loadDailySets();
            }}
          >
            <label>
              시작일
              <input
                type="date"
                value={dailyFrom}
                onChange={(event) => setDailyFrom(event.currentTarget.value)}
                required
              />
            </label>
            <label>
              종료일
              <input
                type="date"
                value={dailyTo}
                onChange={(event) => setDailyTo(event.currentTarget.value)}
                required
              />
            </label>
            <label>
              상태
              <select
                value={dailyStatus}
                onChange={(event) =>
                  setDailyStatus(
                    event.currentTarget.value as DailySetStatus | "",
                  )
                }
              >
                <option value="">전체</option>
                {DAILY_SET_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              type="submit"
              disabled={dailyLoading}
            >
              날짜 범위 조회
            </button>
          </form>

          {dailyIssue ? (
            <ErrorNotice
              issue={dailyIssue}
              onRetry={() => void loadDailySets()}
            />
          ) : null}
          {dailyLoading && dailySets.length === 0 ? (
            <Loading label="데일리 세트 조회 중…" />
          ) : null}
          {!dailyLoading && !dailyIssue && dailySets.length === 0 ? (
            <p className="empty-state">선택한 기간에 데일리 세트가 없습니다.</p>
          ) : null}
          <div className="daily-list" aria-busy={dailyLoading}>
            {dailySets.map((dailySet) => (
              <article className="daily-card" key={dailySet.dailySetId}>
                <div className="card-title-row">
                  <h3>
                    {dailySet.quizDate} · v{dailySet.version}
                  </h3>
                  <div className="status-row">
                    <span className={`status status-${dailySet.status}`}>
                      {STATUS_LABEL[dailySet.status]}
                    </span>
                    {dailySet.void ? (
                      <span className="status status-voided">결과 무효</span>
                    ) : null}
                  </div>
                </div>
                <ol>
                  {dailySet.items.map((item) => (
                    <li key={item.position}>
                      <div className="daily-item-row">
                        <span>
                          <strong>{item.revision.prompt}</strong>
                          <small>
                            {item.revision.category} ·{" "}
                            {item.revision.difficulty} · r
                            {item.revision.revisionNumber} · 순서{" "}
                            {item.choiceOrder.join("-")}
                          </small>
                        </span>
                        <button
                          type="button"
                          className="secondary-button correction-button"
                          disabled={
                            revisionActionBusy !== null ||
                            dailyActionBusy ||
                            voidActionBusy
                          }
                          onClick={() =>
                            startCorrection({
                              questionId: item.revision.questionId,
                              revisionId: item.revision.revisionId,
                              revisionNumber: item.revision.revisionNumber,
                              prompt: item.revision.prompt,
                            })
                          }
                          aria-label={`리비전 ${item.revision.revisionNumber}의 수정 초안 만들기`}
                        >
                          수정 초안 만들기
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
                {dailySet.void ? (
                  <aside
                    className="void-details"
                    aria-label="내부 결과 무효 처리 정보"
                  >
                    <strong>내부 결과 무효 처리 정보</strong>
                    <dl>
                      <div>
                        <dt>작업자</dt>
                        <dd>{dailySet.void.actorSubject}</dd>
                      </div>
                      <div>
                        <dt>처리 일시</dt>
                        <dd>{formatDateTime(dailySet.void.voidedAt)}</dd>
                      </div>
                      <div className="void-reason">
                        <dt>사유</dt>
                        <dd>{dailySet.void.reason}</dd>
                      </div>
                    </dl>
                  </aside>
                ) : null}
                {dailySet.status === "draft" ? (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={dailyActionBusy || voidActionBusy}
                    onClick={() => {
                      setPendingVoid(null);
                      setVoidActionIssue(null);
                      setPendingPublish({
                        dailySetId: dailySet.dailySetId,
                        quizDate: dailySet.quizDate,
                        version: dailySet.version,
                      });
                    }}
                  >
                    게시 확인
                  </button>
                ) : null}
                {dailySet.void === null &&
                (dailySet.status === "published" ||
                  (dailySet.status === "retired" &&
                    dailySet.publishedAt !== null)) ? (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={dailyActionBusy || voidActionBusy}
                    onClick={() => openVoidConfirmation(dailySet)}
                  >
                    결과 무효 처리
                  </button>
                ) : null}
              </article>
            ))}
          </div>

          <details className="create-panel" open>
            <summary>게시된 리비전으로 초안 만들기</summary>
            <form onSubmit={createDailyDraft}>
              <div className="draft-toolbar">
                <label>
                  퀴즈 날짜
                  <input
                    type="date"
                    value={draftDate}
                    onChange={(event) =>
                      setDraftDate(event.currentTarget.value)
                    }
                    required
                  />
                </label>
                <strong>{selectedRevisionIds.length} / 5 선택</strong>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={publishedLoading}
                  onClick={() => void loadPublishedRevisions(false)}
                >
                  게시 리비전 새로고침
                </button>
              </div>
              <p className="muted">
                각 문제의 선택지 순서는 기본 0-1-2-3이며 필요하면 순열을 바꿀 수
                있습니다.
              </p>
              {publishedIssue ? (
                <ErrorNotice
                  issue={publishedIssue}
                  onRetry={() => void loadPublishedRevisions(false)}
                />
              ) : null}
              {publishedLoading && publishedRevisions.length === 0 ? (
                <Loading label="게시된 리비전 조회 중…" />
              ) : null}
              {!publishedLoading &&
              !publishedIssue &&
              publishedRevisions.length === 0 ? (
                <p className="empty-state">
                  선택할 수 있는 게시된 리비전이 없습니다.
                </p>
              ) : null}
              <div className="picker-list" aria-busy={publishedLoading}>
                {publishedRevisions.map((revision) => {
                  const selected = selectedRevisionIds.includes(
                    revision.revisionId,
                  );
                  return (
                    <div
                      className={`picker-row${selected ? " selected" : ""}`}
                      key={revision.revisionId}
                    >
                      <label className="checkbox-label picker-question">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={
                            !selected && selectedRevisionIds.length >= 5
                          }
                          onChange={(event) =>
                            toggleRevision(
                              revision.revisionId,
                              event.currentTarget.checked,
                            )
                          }
                        />
                        <span>
                          <strong>{revision.prompt}</strong>
                          <small>
                            {revision.category} · {revision.difficulty} · r
                            {revision.revisionNumber}
                          </small>
                        </span>
                      </label>
                      {selected ? (
                        <label>
                          선택지 순서
                          <select
                            value={(
                              choiceOrders[revision.revisionId] ??
                              DEFAULT_CHOICE_ORDER
                            ).join("")}
                            onChange={(event) => {
                              const order = CHOICE_ORDERS.find(
                                (candidate) =>
                                  candidate.join("") ===
                                  event.currentTarget.value,
                              );
                              if (order)
                                setChoiceOrders((current) => ({
                                  ...current,
                                  [revision.revisionId]: order,
                                }));
                            }}
                          >
                            {CHOICE_ORDERS.map((order) => (
                              <option
                                key={order.join("")}
                                value={order.join("")}
                              >
                                {order.join(" → ")}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {publishedCursor ? (
                <button
                  type="button"
                  className="secondary-button load-more"
                  disabled={publishedLoading}
                  onClick={() => void loadPublishedRevisions(true)}
                >
                  게시 리비전 더 불러오기
                </button>
              ) : null}
              <div className="form-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    dailyActionBusy ||
                    voidActionBusy ||
                    selectedRevisionIds.length !== 5
                  }
                >
                  {dailyActionBusy ? "처리 중…" : "데일리 세트 초안 생성"}
                </button>
              </div>
            </form>
          </details>

          {latestDraft ? (
            <div className="latest-draft">
              <div>
                <strong>
                  최근 생성: {latestDraft.quizDate} · v{latestDraft.version}
                </strong>
                <code>{latestDraft.dailySetId}</code>
              </div>
              {!latestDraft.published ? (
                <button
                  type="button"
                  className="danger-button"
                  disabled={dailyActionBusy || voidActionBusy}
                  onClick={() => {
                    setPendingVoid(null);
                    setVoidActionIssue(null);
                    setPendingPublish(latestDraft);
                  }}
                >
                  이 초안 게시 확인
                </button>
              ) : (
                <span className="status status-published">게시됨</span>
              )}
            </div>
          ) : null}

          {pendingPublish ? (
            <div
              className="publish-confirm"
              role="alertdialog"
              aria-labelledby="publish-confirm-title"
              aria-describedby="publish-confirm-description"
            >
              <h3 id="publish-confirm-title">
                데일리 세트를 게시하시겠습니까?
              </h3>
              <p id="publish-confirm-description">
                {pendingPublish.quizDate} 버전 {pendingPublish.version}이
                사용자에게 공개됩니다. 게시 전 문제 구성과 날짜를 다시
                확인하세요.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPendingPublish(null)}
                  disabled={dailyActionBusy}
                >
                  취소
                </button>
                <button
                  ref={publishConfirmRef}
                  type="button"
                  className="danger-button"
                  onClick={() => void publishDailySet()}
                  disabled={dailyActionBusy}
                >
                  {dailyActionBusy ? "게시 중…" : "확인하고 게시"}
                </button>
              </div>
            </div>
          ) : null}

          {pendingVoid ? (
            <div
              className="void-confirm"
              role="alertdialog"
              aria-labelledby="void-confirm-title"
              aria-describedby="void-confirm-description"
            >
              <h3 id="void-confirm-title">
                데일리 세트 결과를 무효 처리하시겠습니까?
              </h3>
              <p id="void-confirm-description">
                {pendingVoid.quizDate} 버전 {pendingVoid.version}의 결과 무효
                처리는 되돌릴 수 없습니다. 과거 점수와 리비전은 수정하거나
                재계산하지 않으며, 아래 사유와 작업자·처리 일시는 내부 CMS에만
                표시됩니다.
              </p>
              <form onSubmit={voidDailySet}>
                <label htmlFor="void-reason">
                  처리 사유
                  <textarea
                    ref={voidReasonRef}
                    id="void-reason"
                    name="voidReason"
                    rows={4}
                    minLength={1}
                    maxLength={500}
                    value={voidReason}
                    onChange={(event) =>
                      setVoidReason(event.currentTarget.value)
                    }
                    aria-describedby="void-reason-help void-reason-count"
                    required
                  />
                </label>
                <div className="void-reason-meta">
                  <small id="void-reason-help">
                    1~500자. 동일 사유 재요청은 replay로 확인되며 다른 사유는
                    충돌로 실패합니다.
                  </small>
                  <small id="void-reason-count">
                    {voidReason.length} / 500
                  </small>
                </div>
                {voidActionIssue ? (
                  <ErrorNotice issue={voidActionIssue} />
                ) : null}
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setPendingVoid(null);
                      setVoidReason("");
                      setVoidActionIssue(null);
                    }}
                    disabled={voidActionBusy}
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    className="danger-button"
                    disabled={voidActionBusy || voidReason.trim().length === 0}
                  >
                    {voidActionBusy
                      ? "무효 처리 중…"
                      : "확인하고 결과 무효 처리"}
                  </button>
                </div>
              </form>
            </div>
          ) : null}

          {dailyActionIssue ? <ErrorNotice issue={dailyActionIssue} /> : null}
          {dailySuccess ? (
            <p className="notice success-notice" role="status">
              {dailySuccess}
            </p>
          ) : null}
        </section>

        <section id="reports" className="panel" aria-labelledby="reports-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Safety queue</p>
              <h2 id="reports-title">신고 처리</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={
                reportLoading ||
                reportActionBusy !== null ||
                pendingReportDismiss !== null
              }
              onClick={() => {
                closeReportDismissConfirmation(false);
                setReportActionIssue(null);
                setReportSuccess("");
                void loadReports(false);
              }}
            >
              새로고침
            </button>
          </div>

          <aside className="report-privacy-warning" role="note">
            <strong>개인정보 주의</strong>
            <span>
              신고 상세 내용에는 신고자가 자발적으로 입력한 개인정보가 포함될 수
              있습니다. 콘솔, 저장소, 분석 도구 또는 외부 문서에 복사하지
              마세요.
            </span>
          </aside>

          <form
            className="filter-bar report-filter"
            onSubmit={(event) => {
              event.preventDefault();
              closeReportDismissConfirmation(false);
              setReportActionIssue(null);
              setReportSuccess("");
              void loadReports(false);
            }}
          >
            <label>
              상태
              <select
                value={reportStatus}
                disabled={
                  reportLoading ||
                  reportActionBusy !== null ||
                  pendingReportDismiss !== null
                }
                onChange={(event) =>
                  setReportStatus(
                    event.currentTarget.value as ReportStatus | "",
                  )
                }
              >
                <option value="">전체</option>
                {REPORT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {REPORT_STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              사유
              <select
                value={reportReason}
                disabled={
                  reportLoading ||
                  reportActionBusy !== null ||
                  pendingReportDismiss !== null
                }
                onChange={(event) =>
                  setReportReason(
                    event.currentTarget.value as ReportReason | "",
                  )
                }
              >
                <option value="">전체</option>
                {REPORT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {REPORT_REASON_LABEL[reason]}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              type="submit"
              disabled={
                reportLoading ||
                reportActionBusy !== null ||
                pendingReportDismiss !== null
              }
            >
              신고 조회
            </button>
          </form>

          {reportIssue ? (
            <ErrorNotice
              issue={reportIssue}
              onRetry={() => void loadReports(false)}
            />
          ) : null}
          {reportActionIssue && !pendingReportDismiss ? (
            <ErrorNotice issue={reportActionIssue} />
          ) : null}
          {reportSuccess ? (
            <p
              className="notice success-notice"
              role="status"
              tabIndex={-1}
              ref={reportSuccessRef}
            >
              {reportSuccess}
            </p>
          ) : null}
          {reportLoading && reports.length === 0 ? (
            <Loading label="신고 queue 조회 중…" />
          ) : null}
          {!reportLoading && !reportIssue && reports.length === 0 ? (
            <p className="empty-state">조건에 맞는 신고가 없습니다.</p>
          ) : null}

          <div className="report-list" aria-busy={reportLoading}>
            {reports.map((report) => (
              <article className="report-card" key={report.reportId}>
                <div className="card-title-row">
                  <div>
                    <p className="eyebrow">신고 사유</p>
                    <h3>{REPORT_REASON_LABEL[report.reasonCode]}</h3>
                  </div>
                  <span className={`status status-report-${report.status}`}>
                    {REPORT_STATUS_LABEL[report.status]}
                  </span>
                </div>
                <dl className="metadata-grid">
                  <div>
                    <dt>접수 일시</dt>
                    <dd>{formatDateTime(report.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>
                      {report.questionRevisionId
                        ? "Question Revision ID"
                        : "Challenge ID"}
                    </dt>
                    <dd>
                      <code>
                        {report.questionRevisionId ?? report.challengeId}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>처리 작업자</dt>
                    <dd>{report.triagedBy ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>처리 일시</dt>
                    <dd>{formatDateTime(report.triagedAt)}</dd>
                  </div>
                </dl>
                {report.questionContext ? (
                  <section
                    className="report-detail"
                    aria-label="신고 문항 맥락"
                  >
                    <div className="card-title-row">
                      <div>
                        <strong>신고 문항</strong>
                        <h4>{report.questionContext.prompt}</h4>
                      </div>
                      <span
                        className={`status status-${report.questionContext.status}`}
                      >
                        {STATUS_LABEL[report.questionContext.status]}
                      </span>
                    </div>
                    <dl className="metadata-grid">
                      <div>
                        <dt>Question ID</dt>
                        <dd>
                          <code>{report.questionContext.questionId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Revision ID</dt>
                        <dd>
                          <code>{report.questionContext.revisionId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>리비전 번호</dt>
                        <dd>r{report.questionContext.revisionNumber}</dd>
                      </div>
                      <div>
                        <dt>카테고리</dt>
                        <dd>{report.questionContext.category}</dd>
                      </div>
                      <div>
                        <dt>콘텐츠 상태</dt>
                        <dd>{STATUS_LABEL[report.questionContext.status]}</dd>
                      </div>
                    </dl>
                    <p className="muted">
                      수정 초안은 같은 Question ID의 draft로 생성한 뒤 검토 중,
                      승인됨, 게시됨 lifecycle을 거칩니다. 기존 게시 리비전의
                      폐기는 문제 리비전 영역에서만 처리합니다.
                    </p>
                    <button
                      type="button"
                      className="secondary-button correction-button"
                      disabled={
                        revisionActionBusy !== null ||
                        pendingReportDismiss !== null
                      }
                      onClick={() => startReportCorrection(report)}
                      aria-label={`리비전 ${report.questionContext.revisionNumber}의 수정 초안 만들기`}
                    >
                      수정 초안 만들기
                    </button>
                  </section>
                ) : (
                  <p className="muted">
                    챌린지 대상 신고에는 연결된 문항 맥락이 없습니다.
                  </p>
                )}
                <div className="report-detail">
                  <strong>상세 내용</strong>
                  <p>{report.detail ?? "입력된 상세 내용이 없습니다."}</p>
                </div>
                {REPORT_NEXT_STATUSES[report.status].length > 0 ? (
                  <div className="button-row" aria-label="신고 상태 변경">
                    {REPORT_NEXT_STATUSES[report.status].map((status) =>
                      status === "dismissed" ? (
                        <button
                          key={status}
                          type="button"
                          className="danger-button"
                          disabled={
                            reportLoading ||
                            reportActionBusy !== null ||
                            pendingReportDismiss !== null
                          }
                          onClick={(event) => {
                            reportDismissTriggerRef.current =
                              event.currentTarget;
                            setReportActionIssue(null);
                            setReportSuccess("");
                            setPendingReportDismiss({
                              reportId: report.reportId,
                            });
                          }}
                        >
                          기각
                        </button>
                      ) : (
                        <button
                          key={status}
                          type="button"
                          className="secondary-button"
                          disabled={
                            reportLoading ||
                            reportActionBusy !== null ||
                            pendingReportDismiss !== null
                          }
                          onClick={() => void transitionReport(report, status)}
                        >
                          {reportActionBusy === report.reportId
                            ? "변경 중…"
                            : `${REPORT_STATUS_LABEL[status]}(으)로 변경`}
                        </button>
                      ),
                    )}
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          {pendingReportDismiss ? (
            <div
              className="report-dismiss-confirm"
              role="alertdialog"
              aria-labelledby="report-dismiss-title"
              aria-describedby="report-dismiss-description"
              onKeyDown={(event) => {
                if (event.key === "Escape" && reportActionBusy === null) {
                  event.preventDefault();
                  closeReportDismissConfirmation(true);
                }
              }}
            >
              <h3 id="report-dismiss-title">신고를 기각하시겠습니까?</h3>
              <p id="report-dismiss-description">
                기각 상태로 변경하면 다시 검토 중이나 해결 상태로 되돌릴 수
                없습니다. 신고 내용과 대상을 다시 확인하세요.
              </p>
              {reportActionIssue ? (
                <ErrorNotice issue={reportActionIssue} />
              ) : null}
              <div className="button-row">
                <button
                  ref={reportDismissCancelRef}
                  type="button"
                  className="secondary-button"
                  disabled={reportActionBusy !== null}
                  onClick={() => closeReportDismissConfirmation(true)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={reportActionBusy !== null}
                  onClick={() => {
                    const report = reports.find(
                      (item) => item.reportId === pendingReportDismiss.reportId,
                    );
                    if (report) {
                      void transitionReport(report, "dismissed");
                    } else {
                      closeReportDismissConfirmation(false);
                    }
                  }}
                >
                  {reportActionBusy === pendingReportDismiss.reportId
                    ? "기각 처리 중…"
                    : "확인하고 기각"}
                </button>
              </div>
            </div>
          ) : null}

          {reportCursor ? (
            <button
              type="button"
              className="secondary-button load-more"
              disabled={
                reportLoading ||
                reportActionBusy !== null ||
                pendingReportDismiss !== null
              }
              onClick={() => void loadReports(true)}
            >
              {reportLoading ? "불러오는 중…" : "신고 더 불러오기"}
            </button>
          ) : null}
        </section>

        <section
          id="audit-logs"
          className="panel"
          aria-labelledby="audit-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Traceability</p>
              <h2 id="audit-title">감사 로그</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={auditLoading}
              onClick={() => void loadAuditLogs(false)}
            >
              새로고침
            </button>
          </div>
          {auditIssue ? (
            <ErrorNotice
              issue={auditIssue}
              onRetry={() => void loadAuditLogs(false)}
            />
          ) : null}
          {auditLoading && auditLogs.length === 0 ? (
            <Loading label="감사 로그 조회 중…" />
          ) : null}
          {!auditLoading && !auditIssue && auditLogs.length === 0 ? (
            <p className="empty-state">감사 로그가 없습니다.</p>
          ) : null}
          <div className="table-wrap" aria-busy={auditLoading}>
            {auditLogs.length > 0 ? (
              <table>
                <caption className="sr-only">콘텐츠 변경 감사 로그</caption>
                <thead>
                  <tr>
                    <th scope="col">일시</th>
                    <th scope="col">작업자</th>
                    <th scope="col">동작</th>
                    <th scope="col">리소스</th>
                    <th scope="col">메타데이터</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log, index) => (
                    <tr key={`${log.resourceId}-${log.createdAt}-${index}`}>
                      <td>{formatDateTime(log.createdAt)}</td>
                      <td>{log.actorSubject}</td>
                      <td>{log.action}</td>
                      <td>
                        {log.resourceType}
                        <br />
                        <code>{log.resourceId}</code>
                      </td>
                      <td>
                        {Object.entries(log.metadata)
                          .map(([key, value]) => `${key}: ${String(value)}`)
                          .join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
          {auditCursor ? (
            <button
              type="button"
              className="secondary-button load-more"
              disabled={auditLoading}
              onClick={() => void loadAuditLogs(true)}
            >
              {auditLoading ? "불러오는 중…" : "이전 감사 로그 불러오기"}
            </button>
          ) : null}
        </section>
      </main>
    </div>
  );
}
