/*
 * Úplné prohledání nastavení nástroje Podobné kvartály.
 *
 * Pro každou kombinaci aspoň MIN_K ukazatelů, každé okno W a každý počet výsledků N
 * (s omezením na jeden kvartál z epizody i bez něj) spočítá zpětný test stejně jako
 * kvartaly/index.html (funkce backtest) ve dvou režimech:
 *   - hist: analogy jen z kvartálů c, u kterých bylo v čase t známo, co následovalo (c + H <= t),
 *   - gen:  analogy z celé historie včetně pozdějších kvartálů (kromě okolí ±EX).
 * Odhad = podíl analogů s recesí do H kvartálů; skóre = Brier skill score.
 *
 * Kombinace se procházejí Grayovým kódem, takže se mezi sousedními kombinacemi
 * přičte nebo odečte jen jeden ukazatel. Vstup připravuje search_settings.py.
 *
 * Překlad: gcc -O3 -march=native -fopenmp -o search search.c -lm
 * Použití: ./search vstup.txt > vystup.txt
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _OPENMP
#include <omp.h>
#endif

#define MAXT 512
#define MAXF 32
#define NN 3
#define TOP 10
#define MINROWS 60

static const int NS[NN] = {5, 10, 20};
static int T, F, H, EX, MIN_K, NW, WS[8];
static int rec[MAXT];            /* NBER recese v kvartálu (0/1) */
static int recW[MAXT];           /* recese během následujících H kvartálů, -1 = zatím neznámo */
static double Z[MAXF][MAXT];     /* z-skóre, NAN = chybí */

typedef struct { double bss, acc, prec, base; int n, tp, fp, zeroN, zeroOk; uint32_t mask; int W, N, ep; } Res;
typedef struct { Res r[2][TOP]; int cnt[2]; } Top;

static void top_push(Top *tp, int mode, const Res *r) {
  Res *a = tp->r[mode];
  int n = tp->cnt[mode];
  if (n == TOP && r->bss <= a[n - 1].bss) return;
  int i = n < TOP ? n++ : TOP - 1;
  while (i > 0 && a[i - 1].bss < r->bss) { a[i] = a[i - 1]; i--; }
  a[i] = *r;
  tp->cnt[mode] = n;
}

typedef struct { float d; int c; } Cand;

/* Segmentový strom nad časovými indexy c: kořen drží nejbližšího žijícího kandidáta.
   Výběr s omezením epizod = vzít minimum a „zabít“ okolí ±4; bez omezení = zabít jen vybraný. */
#define P 512   /* horní mez počtu listů */
typedef struct { int n; float val[P]; short idx[2 * P]; } Seg;   /* listy n..2n-1 = kandidáti c = 0..n-1 */

static inline short seg_better(const float *v, short a, short b) { return v[b] < v[a] ? b : a; }

static void seg_build(Seg *s) {
  int n = s->n;
  for (int i = 0; i < n; i++) s->idx[n + i] = i;
  for (int i = n - 1; i >= 1; i--) s->idx[i] = seg_better(s->val, s->idx[2 * i], s->idx[2 * i + 1]);
}
/* Vyřadí kandidáty lo..hi a přepočítá jen dotčené uzly (po úrovních). */
static inline void seg_kill(Seg *s, int lo, int hi) {
  int n = s->n;
  if (lo < 0) lo = 0;
  if (hi > n - 1) hi = n - 1;
  if (lo > hi) return;
  for (int c = lo; c <= hi; c++) s->val[c] = INFINITY;
  /* sestupně: u n, které není mocnina dvou, může být v jednom kroku uzel i s rodičem */
  for (int a = (n + lo) >> 1, b = (n + hi) >> 1; b >= 1; a >>= 1, b >>= 1)
    for (int i = b; i >= (a > 1 ? a : 1); i--) s->idx[i] = seg_better(s->val, s->idx[2 * i], s->idx[2 * i + 1]);
}
/* Vybere až 20 analogů do picked, vrátí jejich počet. Strom se přitom mění. */
static int seg_pick(Seg *s, int ep, int *picked) {
  int np = 0;
  while (np < 20) {
    int c = s->n > 1 ? s->idx[1] : 0;
    if (isinf(s->val[c])) break;
    picked[np++] = c;
    if (ep) seg_kill(s, c - 4, c + 4); else seg_kill(s, c, c);
  }
  return np;
}

typedef struct { int n, sumA, tp, fp, tn, fn, zeroN, zeroOk; double se; } Acc;

static void accumulate(Acc *ac, const int *picked, int np, int actual) {
  for (int k = 0; k < NN; k++) {
    int N = NS[k];
    if (np < N) continue;
    int s = 0;
    for (int j = 0; j < N; j++) s += recW[picked[j]];
    double p = (double)s / N;
    Acc *x = &ac[k];
    x->n++; x->sumA += actual; x->se += (p - actual) * (p - actual);
    int yes = p >= 0.5;
    if (yes && actual) x->tp++; else if (yes) x->fp++; else if (actual) x->fn++; else x->tn++;
    if (s == 0) { x->zeroN++; if (!actual) x->zeroOk++; }
  }
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "použití: search vstup.txt\n"); return 1; }
  FILE *in = fopen(argv[1], "r");
  if (!in) { perror("vstup"); return 1; }
  if (fscanf(in, "%d %d %d %d %d %d", &T, &F, &H, &EX, &MIN_K, &NW) != 6 || T > MAXT || F > MAXF || NW > 8) return 1;
  for (int i = 0; i < NW; i++) if (fscanf(in, "%d", &WS[i]) != 1) return 1;
  for (int t = 0; t < T; t++) if (fscanf(in, "%d", &rec[t]) != 1) return 1;
  char buf[64];
  for (int f = 0; f < F; f++)
    for (int t = 0; t < T; t++) {
      if (fscanf(in, "%63s", buf) != 1) return 1;
      Z[f][t] = strcmp(buf, "nan") ? atof(buf) : NAN;
    }
  fclose(in);
  for (int c = 0; c < T; c++) {
    recW[c] = -1;
    if (c + H < T) { recW[c] = 0; for (int k = 1; k <= H; k++) if (rec[c + k]) recW[c] = 1; }
  }

  const uint32_t FULL = 1u << F;
  long long evaluated = 0;
  Top best = {0};
  const size_t TT = (size_t)T * T;

  for (int wi = 0; wi < NW; wi++) {
    const int W = WS[wi];
    /* Součty čtverců rozdílů a počty dvojic přes okno pro každý ukazatel zvlášť. */
    float *S = malloc(sizeof(float) * F * TT);
    uint8_t *C = malloc(F * TT);
    uint8_t *AV = malloc((size_t)F * T);
    for (int f = 0; f < F; f++) {
      for (int t = 0; t < T; t++) {
        int av = 0;
        for (int k = 0; k < W; k++) if (t - k >= 0 && !isnan(Z[f][t - k])) av++;
        AV[f * T + t] = av;
        for (int c = 0; c < T; c++) {
          double s = 0; int n = 0;
          for (int k = 0; k < W; k++) {
            if (t - k < 0 || c - k < 0) continue;
            double a = Z[f][t - k], b = Z[f][c - k];
            if (isnan(a) || isnan(b)) continue;
            s += (a - b) * (a - b); n++;
          }
          S[f * TT + (size_t)t * T + c] = (float)s;
          C[f * TT + (size_t)t * T + c] = n;
        }
      }
    }

    #pragma omp parallel
    {
      int nth = 1, id = 0;
#ifdef _OPENMP
      nth = omp_get_num_threads(); id = omp_get_thread_num();
#endif
      uint32_t g0 = (uint32_t)((uint64_t)FULL * id / nth), g1 = (uint32_t)((uint64_t)FULL * (id + 1) / nth);
      double *St = calloc(TT, sizeof(double));
      int *Ct = calloc(TT, sizeof(int));
      int av[MAXT] = {0};
      Seg *seg = malloc(sizeof(Seg) * 3);
      Top local = {0};
      long long loc_eval = 0;
      uint32_t mask = g0 ^ (g0 >> 1);
      for (int f = 0; f < F; f++) if (mask >> f & 1) {
        for (size_t i = 0; i < TT; i++) { St[i] += S[f * TT + i]; Ct[i] += C[f * TT + i]; }
        for (int t = 0; t < T; t++) av[t] += AV[f * T + t];
      }
      for (uint32_t g = g0; g < g1; g++) {
        if (g > g0) {
          int f = __builtin_ctz(g);
          mask ^= 1u << f;
          int sgn = mask >> f & 1 ? 1 : -1;
          const float *sf = S + f * TT; const uint8_t *cf = C + f * TT;
          for (size_t i = 0; i < TT; i++) { St[i] += sgn * sf[i]; Ct[i] += sgn * cf[i]; }
          for (int t = 0; t < T; t++) av[t] += sgn * AV[f * T + t];
        }
        if (__builtin_popcount(mask) < MIN_K) continue;
        loc_eval++;
        Acc acc[2][2][NN];   /* [režim][epizody][N] */
        memset(acc, 0, sizeof acc);
        for (int t = W - 1; t < T; t++) {
          int actual = recW[t];
          if (actual < 0 || !av[t]) continue;
          double need = 0.6 * av[t]; if (need < 1) need = 1;
          /* hist: jen kvartály se známým výsledkem v čase t; gen: celá historie */
          const double *srow = St + (size_t)t * T; const int *crow = Ct + (size_t)t * T;
          /* gen: listy c = 0..T-1; hist: jen c = 0..t-H (kvartály se známým výsledkem) */
          seg[1].n = T; seg[0].n = t - H + 1 > 0 ? t - H + 1 : 0;
          int len[2] = {0, 0};
          for (int c = 0; c < T; c++) {
            float d = INFINITY;
            if (c >= W - 1 && abs(c - t) > EX && recW[c] >= 0 && crow[c] >= need) d = (float)(srow[c] / crow[c]);
            seg[1].val[c] = d;
            if (c < seg[0].n) seg[0].val[c] = d;
            if (d < INFINITY) { len[1]++; if (c < seg[0].n) len[0]++; }
          }
          int picked[2][2][20], np[2][2] = {{0, 0}, {0, 0}};
          for (int m = 0; m < 2; m++) {
            if (len[m] < 5) continue;
            Seg *sm = &seg[m];
            seg_build(sm);
            seg[2].n = sm->n;
            memcpy(seg[2].val, sm->val, sizeof(float) * sm->n);
            memcpy(seg[2].idx, sm->idx, sizeof(short) * 2 * sm->n);
            np[m][0] = seg_pick(&seg[2], 0, picked[m][0]);
            np[m][1] = seg_pick(sm, 1, picked[m][1]);
          }
          for (int m = 0; m < 2; m++) for (int ep = 0; ep < 2; ep++) accumulate(acc[m][ep], picked[m][ep], np[m][ep], actual);
        }
        for (int m = 0; m < 2; m++) for (int ep = 0; ep < 2; ep++) for (int k = 0; k < NN; k++) {
          Acc *x = &acc[m][ep][k];
          if (x->n < MINROWS) continue;
          double base = (double)x->sumA / x->n, ref = base * (1 - base), brier = x->se / x->n;
          Res r = { ref > 0 ? 1 - brier / ref : 0, (double)(x->tp + x->tn) / x->n,
                    x->tp + x->fp ? (double)x->tp / (x->tp + x->fp) : -1, base,
                    x->n, x->tp, x->fp, x->zeroN, x->zeroOk, mask, W, NS[k], ep };
          top_push(&local, m, &r);
        }
      }
      #pragma omp critical
      {
        evaluated += loc_eval;
        for (int m = 0; m < 2; m++) for (int i = 0; i < local.cnt[m]; i++) top_push(&best, m, &local.r[m][i]);
      }
      free(St); free(Ct); free(seg);
    }
    free(S); free(C); free(AV);
    fprintf(stderr, "okno %d hotovo\n", W);
  }

  printf("evaluated %lld\n", evaluated * NN * 2);
  const char *names[2] = {"hist", "gen"};
  for (int m = 0; m < 2; m++)
    for (int i = 0; i < best.cnt[m]; i++) {
      Res *r = &best.r[m][i];
      printf("%s %u %d %d %d %.6f %.6f %.6f %.6f %d %d %d %d %d\n", names[m], r->mask, r->W, r->N, r->ep,
             r->bss, r->acc, r->prec, r->base, r->n, r->tp, r->fp, r->zeroN, r->zeroOk);
    }
  return 0;
}
