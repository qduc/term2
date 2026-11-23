import { homedir } from 'node:os';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { Term2Entry } from '../components/Term2Entry';

export default async function Page() {
  await connection();
  const homeFolder = process.env.TERM2_PACKAGED_WEB === 'true' ? homedir() : undefined;
  return (
    <Suspense fallback={null}>
      <Term2Entry homeFolder={homeFolder} />
    </Suspense>
  );
}
