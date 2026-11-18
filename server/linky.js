// "Entrar com LINKY": cliente OpenID Connect (Authorization Code + PKCE S256, state e nonce),
// no mesmo formato do exemplo oficial do LINKY (examples/node/server.mjs).
import * as oidc from 'openid-client';

export const LINKY_ISSUER='https://linky-delta1s-projects.vercel.app/api/identity';

export function createLinky({issuer=LINKY_ISSUER,clientId,clientSecret,appUrl}){
  if(!clientId||!clientSecret)throw new Error('Configure LINKY_CLIENT_ID e LINKY_CLIENT_SECRET (LINKY › Desenvolvedores › Ativar Entrar com LINKY).');
  const redirectUri=new URL('/auth/callback',appUrl).href;
  let configPromise;
  const config=()=>configPromise??=oidc.discovery(new URL(issuer),clientId,{id_token_signed_response_alg:'ES256'},oidc.ClientSecretBasic(clientSecret)).then(c=>{oidc.enableNonRepudiationChecks(c);return c;}).catch(e=>{configPromise=undefined;throw e;});
  return {
    redirectUri,
    // Gera o pedido (guarde verifier/state/nonce no servidor) e a URL para onde mandar o usuário.
    async start({prompt}={}){
      const c=await config(),verifier=oidc.randomPKCECodeVerifier(),state=oidc.randomState(),nonce=oidc.randomNonce();
      const url=oidc.buildAuthorizationUrl(c,{redirect_uri:redirectUri,scope:'openid email profile',code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',state,nonce,...(prompt?{prompt}:{})});
      return {url:url.href,pending:{verifier,state,nonce}};
    },
    // Troca o code, valida o ID token e lê o perfil. Devolve {sub,email,name}.
    async finish(currentUrl,pending){
      const c=await config();
      const tokens=await oidc.authorizationCodeGrant(c,new URL(currentUrl),{pkceCodeVerifier:pending.verifier,expectedState:pending.state,expectedNonce:pending.nonce});
      const sub=tokens.claims().sub,info=await oidc.fetchUserInfo(c,tokens.access_token,sub);
      return {sub,email:info.email||null,emailVerified:!!info.email_verified,name:info.name||null};
    },
  };
}
