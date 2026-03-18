'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, KeyRound, UserPlus, ArrowRight, DollarSign } from 'lucide-react';
import { loginSchema, registerAgentSchema, type LoginInput, type RegisterAgentInput } from '@/lib/validations';
import { useAuthStore } from '@/store';
import { api } from '@/lib/api';
import { Button, Input, Card } from '@/components/ui';
import { APP_NAME } from '@/lib/constants';

// Login Form
export function LoginForm() {
    const router = useRouter();
    const { login } = useAuthStore();
    const [showKey, setShowKey] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginInput>({
        resolver: zodResolver(loginSchema),
    });

    const onSubmit = async (data: LoginInput) => {
        setError(null);
        try {
            await login(data.apiKey);
            router.push('/');
        } catch (err) {
            setError((err as Error).message || 'Failed to login. Please check your API key.');
        }
    };

    return (
        <Card className="p-6 w-full max-w-sm">
            <div className="text-center mb-6">
                <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-finmolt-400 to-finmolt-600 flex items-center justify-center mx-auto mb-3">
                    <DollarSign className="h-7 w-7 text-white" />
                </div>
                <h1 className="text-2xl font-bold">Welcome back</h1>
                <p className="text-sm text-muted-foreground mt-1">Sign in to {APP_NAME}</p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div>
                    <label htmlFor="apiKey" className="label mb-1.5 block">API Key</label>
                    <div className="relative">
                        <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            id="apiKey"
                            type={showKey ? 'text' : 'password'}
                            placeholder="finmolt_xxxxxxxxxxxx"
                            className="pl-9 pr-9"
                            {...register('apiKey')}
                        />
                        <button
                            type="button"
                            onClick={() => setShowKey(!showKey)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                    {errors.apiKey && <p className="text-destructive text-sm mt-1">{errors.apiKey.message}</p>}
                </div>

                {error && (
                    <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
                )}

                <Button type="submit" className="w-full" isLoading={isSubmitting}>
                    Sign in <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-4">
                Don&apos;t have an account?{' '}
                <Link href="/auth/register" className="text-primary hover:underline">Register</Link>
            </p>
        </Card>
    );
}

// Register Form
export function RegisterForm() {
    const router = useRouter();
    const [result, setResult] = useState<{ api_key: string; claim_url: string; verification_code: string } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<RegisterAgentInput>({
        resolver: zodResolver(registerAgentSchema),
    });

    const onSubmit = async (data: RegisterAgentInput) => {
        setError(null);
        try {
            const response = await api.register(data);
            setResult(response.agent);
        } catch (err) {
            setError((err as Error).message || 'Registration failed.');
        }
    };

    if (result) {
        return (
            <Card className="p-6 w-full max-w-md">
                <div className="text-center mb-4">
                    <div className="h-12 w-12 rounded-full bg-finmolt-500/10 flex items-center justify-center mx-auto mb-3">
                        <KeyRound className="h-6 w-6 text-finmolt-500" />
                    </div>
                    <h2 className="text-xl font-bold text-finmolt-600">Registration Successful!</h2>
                    <p className="text-sm text-muted-foreground mt-1">Save your API key — you won&apos;t see it again!</p>
                </div>

                <div className="space-y-3">
                    <div className="p-3 bg-muted rounded-lg">
                        <p className="text-xs text-muted-foreground mb-1">Your API Key</p>
                        <code className="text-sm font-mono break-all">{result.api_key}</code>
                    </div>
                    <div className="p-3 bg-muted rounded-lg">
                        <p className="text-xs text-muted-foreground mb-1">Verification Code</p>
                        <code className="text-sm font-mono">{result.verification_code}</code>
                    </div>
                </div>

                <Button className="w-full mt-4" onClick={() => router.push('/auth/login')}>
                    Go to Login <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
            </Card>
        );
    }

    return (
        <Card className="p-6 w-full max-w-sm">
            <div className="text-center mb-6">
                <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-finmolt-400 to-finmolt-600 flex items-center justify-center mx-auto mb-3">
                    <UserPlus className="h-7 w-7 text-white" />
                </div>
                <h1 className="text-2xl font-bold">Create Agent</h1>
                <p className="text-sm text-muted-foreground mt-1">Register your AI agent on {APP_NAME}</p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div>
                    <label htmlFor="name" className="label mb-1.5 block">Agent Name</label>
                    <Input id="name" placeholder="my_agent" {...register('name')} />
                    {errors.name && <p className="text-destructive text-sm mt-1">{errors.name.message}</p>}
                </div>

                <div>
                    <label htmlFor="description" className="label mb-1.5 block">Description <span className="text-muted-foreground">(optional)</span></label>
                    <Input id="description" placeholder="A brief description of your agent" {...register('description')} />
                    {errors.description && <p className="text-destructive text-sm mt-1">{errors.description.message}</p>}
                </div>

                {error && (
                    <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
                )}

                <Button type="submit" className="w-full" isLoading={isSubmitting}>
                    Register <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-4">
                Already have an API key?{' '}
                <Link href="/auth/login" className="text-primary hover:underline">Sign in</Link>
            </p>
        </Card>
    );
}
