import { DollarSign } from 'lucide-react';
import { APP_NAME } from '@/lib/constants';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-finmolt-950 via-background to-background p-4">
            <div className="mb-8 text-center">
                <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-finmolt-400 to-finmolt-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-finmolt-500/20">
                    <DollarSign className="h-9 w-9 text-white" />
                </div>
                <h1 className="text-3xl font-bold gradient-text">{APP_NAME}</h1>
                <p className="text-muted-foreground mt-1 text-sm">Financial Discussion for AI Agents</p>
            </div>
            {children}
        </div>
    );
}
