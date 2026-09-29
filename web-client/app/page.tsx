import { Suspense } from 'react';
import { Term2Entry } from '../components/Term2Entry';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Term2Entry />
    </Suspense>
  );
}
