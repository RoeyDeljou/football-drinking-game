/** The one place `apps/web` reads its own environment. */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
