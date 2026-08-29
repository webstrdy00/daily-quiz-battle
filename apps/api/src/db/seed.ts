import postgres from "postgres";
import { loadConfig } from "../config.js";
import { getKstDate } from "../shared/time.js";

interface SeedQuestion {
  questionId: string;
  revisionId: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  prompt: string;
  choices: [string, string, string, string];
  correctIndex: number;
  explanation: string;
  sourceUrl: string;
}

const questions: SeedQuestion[] = [
  {
    questionId: "10000000-0000-4000-8000-000000000001",
    revisionId: "20000000-0000-4000-8000-000000000001",
    category: "과학",
    difficulty: "easy",
    prompt: "물의 화학식은 무엇일까요?",
    choices: ["H₂O", "CO₂", "O₂", "NaCl"],
    correctIndex: 0,
    explanation: "물 분자 하나는 수소 원자 2개와 산소 원자 1개로 이루어져요.",
    sourceUrl: "https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185",
  },
  {
    questionId: "10000000-0000-4000-8000-000000000002",
    revisionId: "20000000-0000-4000-8000-000000000002",
    category: "세계",
    difficulty: "easy",
    prompt: "호주의 수도는 어디일까요?",
    choices: ["시드니", "멜버른", "캔버라", "퍼스"],
    correctIndex: 2,
    explanation: "호주의 수도는 시드니가 아니라 캔버라예요.",
    sourceUrl: "https://www.australia.gov.au/about-australia",
  },
  {
    questionId: "10000000-0000-4000-8000-000000000003",
    revisionId: "20000000-0000-4000-8000-000000000003",
    category: "우주",
    difficulty: "medium",
    prompt: "지구의 유일한 자연 위성은 무엇일까요?",
    choices: ["화성", "달", "금성", "태양"],
    correctIndex: 1,
    explanation: "달은 지구 주위를 도는 유일한 자연 위성이에요.",
    sourceUrl: "https://science.nasa.gov/moon/facts/",
  },
  {
    questionId: "10000000-0000-4000-8000-000000000004",
    revisionId: "20000000-0000-4000-8000-000000000004",
    category: "언어",
    difficulty: "medium",
    prompt: "훈민정음을 창제한 조선의 왕은 누구일까요?",
    choices: ["태조", "세종", "영조", "정조"],
    correctIndex: 1,
    explanation: "세종대왕은 백성이 쉽게 글을 익히도록 훈민정음을 창제했어요.",
    sourceUrl: "https://www.hangeul.go.kr/lang/en/html/education/Hangeul.do",
  },
  {
    questionId: "10000000-0000-4000-8000-000000000005",
    revisionId: "20000000-0000-4000-8000-000000000005",
    category: "지리",
    difficulty: "hard",
    prompt: "지구에서 가장 넓은 바다는 무엇일까요?",
    choices: ["대서양", "인도양", "북극해", "태평양"],
    correctIndex: 3,
    explanation: "태평양은 지구 표면에서 가장 넓은 해양이에요.",
    sourceUrl: "https://oceanservice.noaa.gov/facts/biggestocean.html",
  },
];

async function seed(): Promise<void> {
  const config = loadConfig();
  const sql = postgres(config.databaseUrl, { max: 1, prepare: false });
  const quizDate = getKstDate();

  try {
    await sql.begin(async (transaction) => {
      for (const question of questions) {
        await transaction`
          INSERT INTO questions (id)
          VALUES (${question.questionId})
          ON CONFLICT (id) DO NOTHING
        `;

        await transaction`
          INSERT INTO question_revisions (
            id,
            question_id,
            revision_number,
            category,
            difficulty,
            prompt,
            choices,
            correct_index,
            explanation,
            source_url,
            source_checked_at,
            reviewer_id,
            lifecycle_status,
            published_at
          )
          VALUES (
            ${question.revisionId},
            ${question.questionId},
            1,
            ${question.category},
            ${question.difficulty},
            ${question.prompt},
            ${transaction.json(question.choices)},
            ${question.correctIndex},
            ${question.explanation},
            ${question.sourceUrl},
            now(),
            'local-seed-only',
            'published',
            now()
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }

      const existingSet = await transaction<{ id: string; status: string }[]>`
        SELECT id, status
        FROM daily_sets
        WHERE quiz_date = ${quizDate}
        FOR UPDATE
      `;

      let dailySetId: string;
      if (existingSet[0] === undefined) {
        const inserted = await transaction<{ id: string }[]>`
          INSERT INTO daily_sets (quiz_date, status)
          VALUES (${quizDate}, 'draft')
          RETURNING id
        `;
        dailySetId = inserted[0]!.id;
      } else {
        dailySetId = existingSet[0].id;
        if (existingSet[0].status === "published") {
          console.log(`Daily set already published for ${quizDate}`);
          return;
        }
      }

      for (const [index, question] of questions.entries()) {
        await transaction`
          INSERT INTO daily_set_items (
            daily_set_id,
            position,
            question_revision_id,
            choice_order
          )
          VALUES (
            ${dailySetId},
            ${index + 1},
            ${question.revisionId},
            ${transaction.json([0, 1, 2, 3])}
          )
          ON CONFLICT (daily_set_id, position) DO NOTHING
        `;
      }

      await transaction`
        UPDATE daily_sets
        SET status = 'published', published_at = now()
        WHERE id = ${dailySetId} AND status = 'draft'
      `;

      console.log(`Seeded daily set for ${quizDate}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await seed();
