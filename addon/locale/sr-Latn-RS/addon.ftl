service-huoshanweb = Volcengine Web
service-tencenttransmart = Tencent Transmart
service-huoshan = Huoshan
service-googleapi = Google(API)
service-google = Google
service-cnki = CNKI
service-youdao = Youdao
service-youdaozhiyun = Youdao Zhiyun
service-youdaozhiyunllm = Youdao LLM
service-niutranspro = Niu Trans
service-microsoft = Microsoft
service-caiyun = Caiyun
service-libretranslate = LibreTranslate
service-mtranserver = MTranServer
service-deeplfree = DeepL (besplatan paket)
service-deeplpro = DeepL (Pro paket)
service-deeplcustom = DeepLX(API)
service-deeplx = DeepLX
service-baidu = Baidu
service-baidufield = Baidu Field
service-openl = OpenL
service-tencent = Tencent
service-aliyun = Aliyun
service-xftrans = Xftrans
service-chatgpt = ChatGPT
service-customgpt1 = Prilagođeni GPT 1
service-customgpt2 = Prilagođeni GPT 2
service-customgpt3 = Prilagođeni GPT 3
service-azuregpt = AzureGPT
service-gemini = Gemini
service-qwenmt = Qwen-MT
service-claude = Claude
service-haici = Haici
service-iciba = iCIBA
service-bing = Bing
service-pot = Pot
service-nllb = NLLB
service-mymemory = MyMemory
service-bingdict = Bing rečnik (en→zh)🔊
service-cambridgedict = Cambridge rečnik (en→other)🔊
service-haicidict = Haici rečnik (en→zh)🔊
service-collinsdict = Collins rečnik (en→zh)🔊
service-youdaodict = Youdao rečnik (en→zh)🔊
service-freedictionaryapi = FreeDictionaryAPI(en→en)
service-webliodict = Weblio rečnik (en→ja)
service-gramotadict = Gramota.ru(ru)
service-errorPrefix = [Greška zahteva]
    Servis nije dostupan, tajni ključ nije ispravan ili se zahtevi šalju prebrzo.
    Koristi drugi prevodilački servis ili prijavi problem ovde:
    https://github.com/windingwind/zotero-pdf-translate/issues

    Poruka ispod ne dolazi od Zotera ni dodatka Translate, već od servisa
service-niutranspro-error-insufficient-balance =
    Na NiuTrans nalogu nema dovoljno poena, pa zahtev za prevod ne može da se dovrši.
    Kupi poene preko NiuTrans stranice za dopunu i pokušaj ponovo.

    NiuTrans dopuna: https://niutrans.com/price

    Kod greške: { $code } { $message }
service-dialog-config = Podešavanja
service-dialog-title = Podešavanja servisa { $service }
service-dialog-save = Sačuvaj
service-dialog-close = Zatvori
service-dialog-help = Pomoć
service-dialog-custom-request-description = Pogledaj API dokumentaciju pružaoca servisa i dodaj prilagođene parametre. Oni će biti spojeni sa uobičajenim parametrima (model, messages, temperature, stream).
service-dialog-custom-request-title = Prilagođeni parametri zahteva
service-dialog-custom-request-add-param = Dodaj parametar
service-dialog-custom-request-parameter-name = Naziv parametra
service-dialog-custom-request-parameter-value = Vrednost parametra
service-dialog-custom-request-parameter-name-placeholder = Naziv parametra
service-dialog-custom-request-parameter-value-placeholder = Vrednost parametra (JSON format)
service-dialog-custom-request-validation-title = Prilagođeni parametri ne mogu da se sačuvaju
service-dialog-custom-request-validation-summary = Neke vrednosti parametara nisu ispravan JSON. Ispravi ih i pokušaj ponovo.
service-dialog-custom-request-validation-errors-head = Proveri sledeće:
service-dialog-custom-request-validation-error-invalid = - { $key }: neispravan format ({ $detail })
service-dialog-custom-request-validation-error-empty = - { $key }: vrednost je prazna
service-dialog-custom-request-validation-error-duplicate = - { $key }: naziv parametra se ponavlja
service-dialog-custom-request-validation-examples-head = Primeri vrednosti:
service-dialog-custom-request-validation-example-boolean = - Logička vrednost: false
service-dialog-custom-request-validation-example-number = - Broj: 123
service-dialog-custom-request-validation-example-string = - Tekst: "text"
service-dialog-custom-request-validation-example-object = - Objekat: { $example }
service-niutranspro-dialog-endpoint = Adresa servisa
service-niutranspro-dialog-username = Korisničko ime
service-niutranspro-dialog-password = Lozinka
service-niutranspro-dialog-signup = Registruj se
service-niutranspro-dialog-forget = Zaboravljena lozinka
service-niutranspro-dialog-dictLib = Biblioteka rečnika
service-niutranspro-dialog-memoryLib = Biblioteka prevodilačke memorije
service-niutranspro-dialog-tip0 = Idi na
service-niutranspro-dialog-tip1 = NiuTrans Cloud Platform
service-niutranspro-dialog-tip2 = da dodaš biblioteku termina
service-niutranspro-dialog-signin = Prijavi se
service-niutranspro-dialog-refresh = Osveži
service-niutranspro-dialog-signout = Odjavi se
service-deeplcustom-dialog-endPoint = Adresa servisa
service-deeplx-dialog-endPoint = Adresa servisa
service-chatgpt-dialog-endPoint = API adresa
service-chatgpt-dialog-model = Model
service-chatgpt-dialog-temperature = Temperatura
service-chatgpt-dialog-prompt = Uputstvo
service-gpt-dialog-prompt-hint = Dostupne promenljive: { $variables }. { $required } je obavezna.
service-gpt-dialog-prompt-required = Dodajte { $placeholder } da bi izabrani tekst mogao da se pošalje na prevođenje.
service-chatgpt-dialog-stream = Tok odgovora
service-chatgpt-dialog-custom-request = Prilagođeni zahtev
service-azuregpt-dialog-endPoint = Adresa servisa
service-azuregpt-dialog-model = Naziv
service-azuregpt-dialog-temperature = Temperatura
service-azuregpt-dialog-apiVersion = Verzija
service-azuregpt-dialog-prompt = Uputstvo
service-azuregpt-dialog-stream = Tok odgovora
service-azuregpt-dialog-custom-request = Prilagođeni zahtev
service-xftrans-dialog-engine = API mehanizam
service-gemini-dialog-endPoint = Adresa servisa
service-gemini-dialog-prompt = Uputstvo
service-gemini-dialog-stream = Tok odgovora
service-qwenmt-dialog-endPoint = Adresa servisa
service-qwenmt-dialog-model = Model
service-qwenmt-dialog-domains = Oblasti
service-claude-dialog-endPoint = Adresa servisa
service-claude-dialog-model = Model
service-claude-dialog-temperature = Temperatura
service-claude-dialog-prompt = Uputstvo
service-claude-dialog-stream = Tok odgovora
service-claude-dialog-maxTokens = Najviše tokena
service-cnki-settings = Podešavanja
service-cnki-dialog-regex = Regularni izraz za CNKI reklame
service-cnki-dialog-split = Automatski podeli tekst duži od 800 znakova za prevođenje
service-mymemory-dialog-userEmail = Besplatno povećanje limita: unesi e-poštu za 5.000 znakova dnevno po IP adresi
service-aliyun-dialog-action = Radnja
service-aliyun-dialog-scene = Oblast primene
service-tencent-dialog-secretid = Tajni ID
service-tencent-dialog-secretkey = Tajni ključ
service-tencent-dialog-region = Region
service-tencent-dialog-projectid = ID projekta
service-tencent-dialog-termrepoid = ID-jevi zbirki termina (neobavezno)
service-tencent-dialog-sentrepoid = ID-jevi zbirki rečenica (neobavezno)
service-youdaozhiyun-dialog-domain = Oblast
service-youdaozhiyunllm-dialog-model = Model
service-youdaozhiyunllm-dialog-pro = Youdao LLM Pro-14B
service-youdaozhiyunllm-dialog-lite = Youdao LLM Lite-1.5B
service-youdaozhiyunllm-dialog-prompt = Uputstvo
service-youdaozhiyunllm-dialog-stream = Tok odgovora
readerpopup-translate-label = Prevedi
readerpopup-addToNote-label = Dodaj prevod u belešku
pref-title = Translate
field-titleTranslation = Prevod naslova
field-abstractTranslation = Prevod sažetka
status-translating = Prevođenje...
sideBarIcon-title = Prevedi oznaku
service-manageKeys-title = Upravljanje ključevima prevodilačkih servisa
service-manageKeys-head = Upravljaj svim ključevima prevodilačkih servisa. Uredi JSON direktno i izaberi „Sačuvaj“.
service-manageKeys-save = Sačuvaj
service-manageKeys-close = Zatvori
service-renameServices-title = Preimenuj prilagođene GPT servise
service-renameServices-head = Unesi novi naziv i izaberi „Sačuvaj“.
service-renameServices-hint = Izmene važe posle ponovnog pokretanja dodatka ili Zotera
service-renameServices-save = Sačuvaj
service-renameServices-close = Zatvori
service-libretranslate-dialog-endPoint = API adresa
service-mtranserver-dialog-endPoint = Adresa servisa
service-mtranserver-dialog-versionlabel = Koristi MTranServer v3.0.0+
service-pot-dialog-port = Port
service-nllb-dialog-model = nllb model
service-nllb-dialog-apiendpoint = nllb-api adresa servisa
service-nllb-dialog-apistream = nllb-api tok odgovora
service-nllb-dialog-serveendpoint = nllb-serve adresa servisa
service-nllb-dialog-apilabel = nllb-api dokumentacija
service-nllb-dialog-servelabel = nllb-serve dokumentacija

service-wordstalk = WordsTalk Academic Translation

service-dialog-custom-headers-description=Refer to API documentation of service provider, add custom request headers (names are case-insensitive). These will be merged with the standard headers; headers set by the plugin (Content-Type, Authorization, etc.) cannot be overridden.

service-dialog-custom-headers-title=Custom Request Headers

service-dialog-custom-headers-add-header=Add Header

service-dialog-custom-headers-name=Header Name

service-dialog-custom-headers-value=Header Value

service-dialog-custom-headers-name-placeholder=Header name (e.g. x-opencode-session)

service-dialog-custom-headers-value-placeholder=Header value

service-dialog-custom-headers-validation-title=Can't Save Custom Headers

service-dialog-custom-headers-validation-summary=Some custom headers are not valid. Please fix them and try again.

service-dialog-custom-headers-validation-errors-head=Please check:

service-dialog-custom-headers-validation-error-empty=- { $key }: value is empty

service-dialog-custom-headers-validation-error-duplicate=- { $key }: duplicate header name

service-dialog-custom-headers-validation-error-invalid-name=- { $key }: invalid header name

service-dialog-api-format-openai=OpenAI (chat/completions)

service-dialog-api-format-anthropic=Anthropic (messages)

service-gpt-dialog-thinkingLevel-hint=The thinking parameter format is auto-detected from the endpoint (OpenAI/Azure, OpenRouter, GLM, DeepSeek, Kimi, Doubao, Qwen). Nothing is sent for unrecognized endpoints (e.g. relays) — use Custom Request to set the parameter manually.

service-dialog-thinking-default=Default

service-dialog-thinking-off=Off

service-dialog-thinking-low=Low

service-dialog-thinking-medium=Medium

service-dialog-thinking-high=High

service-chatgpt-dialog-apiFormat=API Format

service-gpt-dialog-apiFormat-hint=The EndPoint accepts the base URL from the provider docs: https://api.deepseek.com becomes https://api.deepseek.com/v1/chat/completions (Anthropic format: https://api.anthropic.com/v1/messages). Any already complete URL, e.g. https://api.openai.com/v1/chat/completions or https://api.openai.com/v1/responses, is used as typed. For the Anthropic format the key is sent as x-api-key.

service-chatgpt-dialog-thinkingLevel=Thinking

service-chatgpt-dialog-custom-headers=Custom Request Headers

service-azuregpt-dialog-thinkingLevel=Thinking

service-azuregpt-dialog-custom-headers=Custom Request Headers

service-gemini-dialog-thinkingLevel=Thinking

service-claude-dialog-thinkingLevel=Thinking

service-wordstalk-info=Get a personal key from the link below, paste it into the Secret field in Translation settings, then select text to translate. Uses paid WordsTalk fast-translation quota. Text containing Chinese characters (including Japanese kanji) is translated into English; other text into simplified Chinese. The target-language setting does not apply. Up to 5,000 characters per request.

service-wordstalk-error-key=Enter an enabled WordsTalk personal key from https://wordstalk.ai/connect-tools. Check that the full key was copied correctly.

service-wordstalk-error-empty=Select some text to translate.

service-wordstalk-error-length=WordsTalk allows up to 5,000 characters per request. Select a shorter passage.

service-wordstalk-error-quota=Your WordsTalk fast-translation quota is insufficient. Check your balance on WordsTalk.

service-wordstalk-error-request=WordsTalk could not accept this translation request. Check the selected text or contact WordsTalk support.

service-wordstalk-error-rate=WordsTalk is receiving too many requests. Please wait before trying again.

service-wordstalk-error-network=The WordsTalk request did not complete. Check your connection and account balance before retrying; the server may already have processed it.

service-wordstalk-error-server=WordsTalk returned HTTP { $status }. Check your balance or contact WordsTalk support before retrying.

service-wordstalk-error-response=WordsTalk returned no valid translation. Check your balance or contact WordsTalk support before retrying.

service-customgpt4=Custom GPT 4

service-customgpt5=Custom GPT 5

service-customgpt6=Custom GPT 6

service-customgpt7=Custom GPT 7

service-customgpt8=Custom GPT 8

service-customgpt9=Custom GPT 9

service-customgpt10=Custom GPT 10

service-customgpt11=Custom GPT 11

service-customgpt12=Custom GPT 12

service-customgpt13=Custom GPT 13

service-customgpt14=Custom GPT 14

service-customgpt15=Custom GPT 15

service-customgpt16=Custom GPT 16

service-customgpt17=Custom GPT 17

service-customgpt18=Custom GPT 18

service-customgpt19=Custom GPT 19

service-customgpt20=Custom GPT 20

service-customgpt-generic=Custom GPT { $index }

service-deeplcustom-dialog-glossary=Glossary

service-gemini-dialog-maxOutputTokens=Max Output Tokens

itemmenu-translateTitle-label=Translate Title

itemmenu-translateAbstract-label=Translate Abstract

itemmenu-more-label=More Translation Options...

itemmenu-retranslateTitle-label=Retranslate Title

itemmenu-retranslateAbstract-label=Retranslate Abstract

service-fetchModels-title = Fetch Models

service-fetchModels-fetching = Fetching models…

service-fetchModels-unsupported = The current service does not support fetching models.

service-fetchModels-failed = Failed to fetch models. Check the endpoint and secret.

service-fetchModels-done = Fetched { $count } models.
