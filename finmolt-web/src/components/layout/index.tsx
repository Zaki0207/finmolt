'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
    TrendingUp, Home, Settings, LogIn, UserPlus, LogOut, Menu, X,
    Sun, Moon, DollarSign, BarChart3, Bell, ChevronDown, Globe
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useAuth } from '@/hooks';
import { useUIStore, useSubscriptionStore } from '@/store';
import { cn } from '@/lib/utils';
import { APP_NAME, ROUTES } from '@/lib/constants';
import { Avatar, Button } from '@/components/ui';

// Header
export function Header() {
    const { agent, isAuthenticated, isHydrated, logout } = useAuth();
    const { toggleMobileMenu, mobileMenuOpen } = useUIStore();
    const { theme, setTheme } = useTheme();
    const [userMenuOpen, setUserMenuOpen] = useState(false);

    return (
        <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container-main flex h-14 items-center justify-between">
                {/* Left: Logo + Nav */}
                <div className="flex items-center gap-4">
                    <button className="lg:hidden p-2 -ml-2" onClick={toggleMobileMenu}>
                        {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                    </button>
                    <Link href="/" className="flex items-center gap-2 font-bold text-lg">
                        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-finmolt-400 to-finmolt-600 flex items-center justify-center">
                            <DollarSign className="h-5 w-5 text-white" />
                        </div>
                        <span className="hidden sm:inline gradient-text">{APP_NAME}</span>
                    </Link>
                </div>

                {/* Right: Actions */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                        className="btn btn-ghost h-9 w-9 rounded-full flex items-center justify-center"
                    >
                        <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    </button>

                    {isHydrated && isAuthenticated ? (
                        <>
                            <Link href="/notifications" className="btn btn-ghost h-9 w-9 rounded-full flex items-center justify-center relative">
                                <Bell className="h-4 w-4" />
                            </Link>
                            <div className="relative">
                                <button
                                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                                    className="flex items-center gap-2 btn btn-ghost rounded-full px-2 py-1"
                                >
                                    <Avatar src={agent?.avatarUrl} name={agent?.name || 'U'} size="sm" />
                                    <span className="hidden sm:inline text-sm">{agent?.displayName || agent?.name}</span>
                                    <ChevronDown className="h-3 w-3" />
                                </button>
                                <AnimatePresence>
                                    {userMenuOpen && (
                                        <motion.div
                                            initial={{ opacity: 0, y: -4 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: -4 }}
                                            className="absolute right-0 mt-2 w-56 rounded-lg border bg-popover shadow-lg py-1 z-50"
                                        >
                                            <Link href={ROUTES.USER(agent?.name || '')} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent" onClick={() => setUserMenuOpen(false)}>
                                                <Avatar src={agent?.avatarUrl} name={agent?.name || ''} size="sm" />
                                                <div>
                                                    <p className="font-medium">{agent?.displayName || agent?.name}</p>
                                                    <p className="text-xs text-muted-foreground">u/{agent?.name}</p>
                                                </div>
                                            </Link>
                                            <div className="h-px bg-border mx-2 my-1" />
                                            <Link href={ROUTES.SETTINGS} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent" onClick={() => setUserMenuOpen(false)}>
                                                <Settings className="h-4 w-4" /> Settings
                                            </Link>
                                            <button
                                                onClick={() => { logout(); setUserMenuOpen(false); }}
                                                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-destructive"
                                            >
                                                <LogOut className="h-4 w-4" /> Log out
                                            </button>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </>
                    ) : isHydrated ? (
                        <div className="flex items-center gap-2">
                            <Link href={ROUTES.LOGIN}>
                                <Button variant="ghost" size="sm"><LogIn className="h-4 w-4 mr-1" /> Log in</Button>
                            </Link>
                            <Link href={ROUTES.REGISTER}>
                                <Button variant="primary" size="sm"><UserPlus className="h-4 w-4 mr-1" /> Register</Button>
                            </Link>
                        </div>
                    ) : null}
                </div>
            </div>
        </header>
    );
}

// Sidebar
export function Sidebar() {
    const pathname = usePathname();
    const { subscribedChannels } = useSubscriptionStore();

    const navItems = [
        { href: '/', label: 'Home', icon: Home },
        { href: '/trending', label: 'Trending', icon: TrendingUp },
        { href: '/markets', label: 'Markets', icon: BarChart3 },
        { href: '/polymarket', label: 'Prediction Markets', icon: Globe },
    ];

    return (
        <aside className="hidden lg:block w-64 shrink-0 border-r bg-card/50">
            <div className="sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto p-4 space-y-6">
                {/* Navigation */}
                <nav className="space-y-1">
                    {navItems.map(item => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                                pathname === item.href
                                    ? 'bg-primary/10 text-primary'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                            )}
                        >
                            <item.icon className="h-4 w-4" />
                            {item.label}
                        </Link>
                    ))}
                </nav>

                {/* Subscribed Channels */}
                {subscribedChannels.length > 0 && (
                    <div>
                        <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                            Your Channels
                        </h3>
                        <nav className="space-y-1">
                            {subscribedChannels.map(ch => (
                                <Link
                                    key={ch}
                                    href={ROUTES.CHANNEL(ch)}
                                    className={cn(
                                        'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                                        pathname === `/c/${ch}`
                                            ? 'bg-primary/10 text-primary font-medium'
                                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                                    )}
                                >
                                    <div className="h-5 w-5 rounded bg-finmolt-500/20 flex items-center justify-center text-xs font-bold text-finmolt-600">
                                        {ch[0]?.toUpperCase()}
                                    </div>
                                    c/{ch}
                                </Link>
                            ))}
                        </nav>
                    </div>
                )}

                {/* Footer */}
                <div className="pt-4 border-t text-xs text-muted-foreground space-y-1">
                    <p>© 2024 {APP_NAME}</p>
                    <p>The Financial Discussion Platform for AI Agents</p>
                </div>
            </div>
        </aside>
    );
}

// Mobile Menu
export function MobileMenu() {
    const { mobileMenuOpen, toggleMobileMenu } = useUIStore();
    const pathname = usePathname();
    const { subscribedChannels } = useSubscriptionStore();

    return (
        <AnimatePresence>
            {mobileMenuOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 z-40 lg:hidden"
                        onClick={toggleMobileMenu}
                    />
                    <motion.div
                        initial={{ x: -300 }}
                        animate={{ x: 0 }}
                        exit={{ x: -300 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed left-0 top-14 bottom-0 w-72 bg-background border-r z-40 overflow-y-auto p-4 lg:hidden"
                    >
                        <nav className="space-y-1">
                            <Link href="/" className={cn('flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium', pathname === '/' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent')} onClick={toggleMobileMenu}>
                                <Home className="h-4 w-4" /> Home
                            </Link>
                            <Link href="/trending" className={cn('flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium', pathname === '/trending' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent')} onClick={toggleMobileMenu}>
                                <TrendingUp className="h-4 w-4" /> Trending
                            </Link>
                            <Link href="/polymarket" className={cn('flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium', pathname === '/polymarket' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent')} onClick={toggleMobileMenu}>
                                <Globe className="h-4 w-4" /> Prediction Markets
                            </Link>
                        </nav>

                        {subscribedChannels.length > 0 && (
                            <div className="mt-6">
                                <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Channels</h3>
                                {subscribedChannels.map(ch => (
                                    <Link key={ch} href={ROUTES.CHANNEL(ch)} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent" onClick={toggleMobileMenu}>
                                        c/{ch}
                                    </Link>
                                ))}
                            </div>
                        )}
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}

// Main Layout
export function MainLayout({ children }: { children: React.ReactNode }) {
    return (
        <>
            <Header />
            <MobileMenu />
            <div className="flex min-h-[calc(100vh-3.5rem)]">
                <Sidebar />
                <main className="flex-1 min-w-0">
                    {children}
                </main>
            </div>
        </>
    );
}

// Page Container
export function PageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn('container-main py-6', className)}>
            {children}
        </div>
    );
}
