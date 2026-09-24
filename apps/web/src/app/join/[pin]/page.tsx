import { JoinForm } from '@/components/JoinForm';

export default function JoinWithPinPage({
  params,
}: {
  readonly params: { readonly pin: string };
}): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <h1 className="text-center text-3xl font-black">Join a room</h1>
      <JoinForm initialPin={params.pin} />
    </main>
  );
}
