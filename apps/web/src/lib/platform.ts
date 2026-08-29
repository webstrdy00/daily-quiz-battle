import { User } from "@apps-in-toss/web-framework";

const isDevelopment =
  import.meta.env.DEV || import.meta.env.VITE_APP_ENV === "development";

export async function getAnonymousKey(): Promise<string> {
  try {
    const result = await User.getAnonymousKey();
    if (result.type === "HASH" && result.hash.length > 0) {
      return result.hash;
    }
  } catch {
    if (!isDevelopment) {
      throw new Error("앱인토스 사용자 정보를 가져오지 못했습니다.");
    }
  }

  const developmentKey = import.meta.env.VITE_DEV_ANONYMOUS_KEY;
  if (isDevelopment && developmentKey?.startsWith("dev-")) {
    return developmentKey;
  }

  throw new Error("사용자 식별 정보를 준비하지 못했습니다.");
}
