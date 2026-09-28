package ui

type HomeData struct {
	APIBase   string
	ListenTip string
}

type StepView struct {
	N        int
	Title    string
	Purpose  string
	How      string
	LookFor  string
	Next     string
	Commands []string
	Tools    []string
}

type FileView struct {
	Path        string
	Content     string
	Placeholder bool
}

type ResultView struct {
	Title          string
	Playbook       string
	Scope          string
	Mode           string
	Language       string
	Complexity     int
	Credits        int
	PlanStatus     string
	ScaffoldStatus string
	LabNotice      string
	Note           string
	Steps          []StepView
	Files          []FileView
	ZipBase64      string
}
