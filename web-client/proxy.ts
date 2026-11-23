import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  // A loopback bind alone isn't sufficient: the browser can arrive at that
  // address with a non-local Host. Protect reads as well as mutations.
  if (process.env.TERM2_PACKAGED_WEB === 'true') {
    const host = request.headers.get('host');
    if (!host || !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host)) {
      return new NextResponse('Invalid host', { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
