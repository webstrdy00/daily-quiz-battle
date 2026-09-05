import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";

interface AccountSettingsProps {
  busy: boolean;
  error: {
    title: string;
    message: string;
    requestId?: string;
  } | null;
  headingRef: Ref<HTMLHeadingElement>;
  notificationBusy: boolean;
  notificationEnabled: boolean | null;
  notificationError: {
    title: string;
    message: string;
    requestId?: string;
  } | null;
  onCancel: () => void;
  onDelete: () => void;
  onClearError: () => void;
  onReloadNotification: () => void;
  onToggleNotification: () => void;
}

export function AccountSettings({
  busy,
  error,
  headingRef,
  notificationBusy,
  notificationEnabled,
  notificationError,
  onCancel,
  onDelete,
  onClearError,
  onReloadNotification,
  onToggleNotification,
}: AccountSettingsProps) {
  const [confirmation, setConfirmation] = useState("");
  const [confirming, setConfirming] = useState(false);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const finalHeadingRef = useRef<HTMLHeadingElement>(null);
  const restoreContinueFocusRef = useRef(false);
  const confirmationMatches = confirmation === "DELETE";
  const notificationControlsDisabled = busy || confirming;

  useEffect(() => {
    if (confirming) {
      finalHeadingRef.current?.focus();
    } else if (restoreContinueFocusRef.current) {
      restoreContinueFocusRef.current = false;
      continueButtonRef.current?.focus();
    }
  }, [confirming]);

  const handleContinue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmationMatches || busy || notificationBusy) {
      return;
    }
    onClearError();
    setConfirming(true);
  };

  return (
    <main
      className="app-shell settings-shell"
      aria-busy={busy || notificationBusy}
    >
      <section className="card settings-card" aria-labelledby="settings-title">
        <p className="eyebrow">ACCOUNT SETTINGS</p>
        <h1 id="settings-title" ref={headingRef} tabIndex={-1}>
          계정 설정
        </h1>

        <section aria-labelledby="result-notification-title">
          <h2 id="result-notification-title">퀴즈 결과 알림</h2>
          <p>
            오늘의 퀴즈 결과가 준비되면 토스 알림으로 알려드려요. 알림을 켤 때는
            토스 동의 화면에서 직접 동의해야 합니다.
          </p>
          <p aria-live="polite">
            {notificationBusy
              ? "결과 알림 설정을 처리하는 중…"
              : notificationEnabled === true
                ? "현재 결과 알림이 켜져 있어요."
                : notificationEnabled === false
                  ? "현재 결과 알림이 꺼져 있어요."
                  : "현재 결과 알림 설정을 확인하지 못했어요."}
          </p>
          {notificationError ? (
            <div className="inline-error" role="alert">
              <strong>{notificationError.title}</strong>
              <span>{notificationError.message}</span>
              {notificationError.requestId ? (
                <small>문의 코드: {notificationError.requestId}</small>
              ) : null}
            </div>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            onClick={
              notificationEnabled === null
                ? onReloadNotification
                : onToggleNotification
            }
            disabled={notificationControlsDisabled || notificationBusy}
          >
            {notificationBusy
              ? "처리 중…"
              : notificationEnabled === true
                ? "결과 알림 끄기"
                : notificationEnabled === false
                  ? "결과 알림 켜기"
                  : "설정 다시 불러오기"}
          </button>
        </section>

        {confirming ? (
          <div className="delete-confirmation">
            <h2 ref={finalHeadingRef} tabIndex={-1}>
              정말 계정을 삭제할까요?
            </h2>
            <p>
              삭제하면 현재 계정의 퀴즈 진행 상황, 점수, 도전장 기록을 복구할 수
              없어요.
            </p>
            {error ? (
              <div className="inline-error" role="alert">
                <strong>{error.title}</strong>
                <span>{error.message}</span>
                {error.requestId ? (
                  <small>문의 코드: {error.requestId}</small>
                ) : null}
              </div>
            ) : null}
            <button
              className="danger-button"
              type="button"
              onClick={onDelete}
              disabled={busy}
            >
              {busy ? "계정을 삭제하는 중…" : "계정 영구 삭제"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                onClearError();
                restoreContinueFocusRef.current = true;
                setConfirming(false);
              }}
              disabled={busy}
            >
              이전으로
            </button>
          </div>
        ) : (
          <form className="delete-form" onSubmit={handleContinue}>
            <h2>계정 삭제</h2>
            <p>
              계정을 삭제하면 저장된 퀴즈 진행 상황과 점수, 생성하거나 참여한
              도전장 기록이 영구적으로 삭제돼요. 이 작업은 되돌릴 수 없습니다.
            </p>
            <label htmlFor="delete-confirmation">
              계속하려면 아래에 <strong>DELETE</strong>를 입력해 주세요.
            </label>
            <input
              id="delete-confirmation"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                onClearError();
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <button
              ref={continueButtonRef}
              className="danger-button"
              type="submit"
              disabled={!confirmationMatches || busy || notificationBusy}
            >
              계정 삭제 계속
            </button>
          </form>
        )}

        <button
          className="text-button settings-cancel"
          type="button"
          onClick={onCancel}
          disabled={busy || notificationBusy}
        >
          취소하고 돌아가기
        </button>
      </section>
    </main>
  );
}
