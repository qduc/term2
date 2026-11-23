import { homedir } from 'node:os';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { Term2Entry } from '../components/Term2Entry';

export default async function Page() {
  await connection();
  const homeFolder = process.env.TERM2_PACKAGED_WEB === 'true' ? homedir() : undefined;
  const allowWrite = process.env.TERM2_WEB_ALLOW_WRITE === 'true';
  return (
    <Suspense fallback={null}>
      <Term2Entry homeFolder={homeFolder} allowWrite={allowWrite} />
    </Suspense>
  );
}
