import { AgeGateGuard } from '@/components/AgeGateGuard';
import { BackButton } from '@/components/BackButton';
import { JoinForm } from '@/components/JoinForm';

export default function JoinWithPinPage({
  params,
}: {
  readonly params: { readonly pin: string };
}): React.JSX.Element {
  return (
    <AgeGateGuard>
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
        {/* Arrived via a direct link/QR code: there is no in-app history to pop, so this always
            falls back to an explicit push to "/" rather than risking leaving the app entirely. */}
        <BackButton fallbackHref="/" />
        <h1 className="text-center text-3xl font-black">Join a room</h1>
        <JoinForm initialPin={params.pin} />
      </main>
    </AgeGateGuard>
  );
}
