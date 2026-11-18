// Hash link of the "Тест" screen for a quiz (by slug). A tiny module so the
// course screen and the reader can link to a quiz without importing the whole
// quiz screen.
import { link } from '../router.js';

export const quizLink = (courseId, quiz) => link('c', courseId, 'quiz', quiz.slug || quiz.id);
