export interface ChallengeContext {
  generation: number;
  requestGeneration: number;
  userId: string | null;
  token: string | null;
  quizDate: string | null;
  accountDeleted: boolean;
}

export function isChallengeContextCurrent(
  request: ChallengeContext,
  current: ChallengeContext,
): boolean {
  return (
    !request.accountDeleted &&
    !current.accountDeleted &&
    request.generation === current.generation &&
    request.requestGeneration === current.requestGeneration &&
    request.userId === current.userId &&
    request.token === current.token &&
    request.quizDate === current.quizDate
  );
}

export async function runChallengeRequest<T>(options: {
  request: () => Promise<T>;
  isCurrent: () => boolean;
  onResult: (result: T) => void;
  onError: (error: unknown) => void;
  onFinally: () => void;
}): Promise<void> {
  try {
    const result = await options.request();
    if (options.isCurrent()) options.onResult(result);
  } catch (error) {
    if (options.isCurrent()) options.onError(error);
  } finally {
    if (options.isCurrent()) options.onFinally();
  }
}

export function isDraftForQuizDate(
  draft: { userId: string; quizDate: string } | null,
  userId: string | null,
  quizDate: string,
): boolean {
  return (
    draft !== null && draft.userId === userId && draft.quizDate === quizDate
  );
}
