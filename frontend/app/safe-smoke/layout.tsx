import { Web3Providers } from '@/components/app/web3-providers';

export default function SafeSmokeLayout({ children }: { children: React.ReactNode }) {
  return <Web3Providers>{children}</Web3Providers>;
}
