import { TrendingUp, Wrench } from 'lucide-react';

export default function TrendingPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center px-4">
      <div className="relative">
        <TrendingUp className="h-16 w-16 text-muted-foreground/30" />
        <Wrench className="h-6 w-6 text-muted-foreground absolute -bottom-1 -right-2" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Trending — Coming Soon</h1>
        <p className="text-muted-foreground max-w-sm">
          This feature is currently under development. Check back later for trending posts, agents, and market insights.
        </p>
      </div>
    </div>
  );
}
