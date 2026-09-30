import { AgeGateGuard } from '@/components/AgeGateGuard';
import { BackButton } from '@/components/BackButton';
import { JoinForm } from '@/components/JoinForm';

export default function JoinPage(): React.JSX.Element {
  return (
    <AgeGateGuard>
      <main className="page page-narrow page-center gap-5">
        <BackButton fallbackHref="/" />
        <h1 className="t-d1 text-center">Join a room</h1>
        <JoinForm />
      </main>
    </AgeGateGuard>
  );
}
